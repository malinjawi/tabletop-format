#!/usr/bin/env python3
"""build_site.py - static game page generator (UI prototype), format v0.1.
Usage: python3 tools/build_site.py <game-dir> [--diff <new-cards.json>] [-o out.html]

Generates a SELF-CONTAINED html page (images inlined) from a game directory:
  Cards grid · visual Changes tab (before/after renders + field diffs) ·
  Formats & banlist (with designer notes) · Decks with live legality ·
  license/provenance badges · Remix affordance.
This is the Block I prototype: what the platform's game page will be, built
today from pure format data. No server, no build step, opens anywhere.
"""
import base64, html, json, subprocess, sys, tempfile
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent

def b64(p):
    return "data:image/png;base64," + base64.b64encode(Path(p).read_bytes()).decode()

def load_dir(game_dir, d):
    p = game_dir / d
    if not p.is_dir(): return []
    out = []
    for f in sorted(p.iterdir()):
        if f.suffix in (".yaml", ".yml", ".json"):
            doc = yaml.safe_load(f.read_text())
            out.extend(doc if isinstance(doc, list) else [doc])
    return out

def flatten(c):
    d = {"name": c.get("name"), "type": c.get("type"),
         "subtypes": ", ".join(c.get("subtypes", [])), "text": c.get("text", ""),
         "keywords": ", ".join(c.get("keywords", [])), "deck_limit": c.get("deck_limit")}
    for k, v in (c.get("attributes") or {}).items(): d[f"attributes.{k}"] = v
    return d

def card_diff(old_cards, new_cards):
    o = {c["id"]: c for c in old_cards}; n = {c["id"]: c for c in new_cards}
    out = []
    for cid, oc in o.items():
        nc = n.get(cid)
        if not nc: out.append({"id": cid, "kind": "removed", "name": oc["name"], "fields": []}); continue
        of, nf = flatten(oc), flatten(nc)
        fields = [{"field": k, "from": of.get(k), "to": nf.get(k)}
                  for k in set(of) | set(nf) if of.get(k) != nf.get(k)]
        if fields: out.append({"id": cid, "kind": "changed", "name": nc["name"], "fields": fields})
    for cid, nc in n.items():
        if cid not in o: out.append({"id": cid, "kind": "added", "name": nc["name"], "fields": []})
    return out

def main():
    args = sys.argv[1:]
    game_dir = Path(args[0])
    diff_path = Path(args[args.index("--diff") + 1]) if "--diff" in args else None
    out_path = Path(args[args.index("-o") + 1]) if "-o" in args else game_dir / "exports" / "site.html"

    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = json.loads((game_dir / "components/cards.json").read_text())
    printings = json.loads((game_dir / "components/printings.json").read_text())
    sets_ = {s["id"]: s for s in load_dir(game_dir, "sets")}
    formats = load_dir(game_dir, "formats")
    restrictions = {r["id"]: r for r in load_dir(game_dir, "restrictions")}
    decks = load_dir(game_dir, "decks")
    faces = game_dir / "exports" / "faces"
    if not faces.is_dir():
        subprocess.run([sys.executable, str(ROOT / "tools/render_cards.py"), str(game_dir)], check=True)

    cards_by_id = {c["id"]: c for c in cards}
    first_printing = {}
    for p in printings: first_printing.setdefault(p["card_id"], p)

    # ---- Changes tab data ----
    changes, after_imgs = [], {}
    if diff_path:
        new_cards = json.loads(diff_path.read_text())
        changes = card_diff(cards, new_cards)
        # render "after" faces into a temp copy of the game
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "g"
            subprocess.run(["cp", "-r", str(game_dir), str(tmp)], check=True)
            (tmp / "components/cards.json").write_text(json.dumps(new_cards))
            subprocess.run([sys.executable, str(ROOT / "tools/render_cards.py"), str(tmp), str(tmp / "faces2")], check=True)
            for ch in changes:
                if ch["kind"] != "removed":
                    pid = first_printing.get(ch["id"], {}).get("id")
                    f = tmp / "faces2" / f"{pid}.png"
                    if pid and f.exists(): after_imgs[ch["id"]] = b64(f)

    # ---- deck legality via check_deck.py ----
    deck_results = []
    for d in decks:
        # find the deck file again (loaded flat); rerun checker per file
        f = next((x for x in (game_dir / "decks").iterdir() if x.suffix == ".json" and json.loads(x.read_text())["id"] == d["id"]), None)
        r = subprocess.run([sys.executable, str(ROOT / "tools/check_deck.py"), str(game_dir), str(f)],
                           capture_output=True, text=True)
        deck_results.append((d, r.returncode == 0, r.stdout.strip().splitlines()))

    e = html.escape
    def card_tile(c):
        pid = first_printing.get(c["id"], {}).get("id")
        img = b64(faces / f"{pid}.png") if pid and (faces / f"{pid}.png").exists() else ""
        return f'<div class="tile"><img src="{img}" alt="{e(c["name"])}"><div class="tname">{e(c["name"])}</div></div>'

    lic = e(str(game.get("license", "?")))
    prov = (game.get("default_provenance") or {}).get("source", "?")
    attr = game.get("attribution")

    changes_html = ""
    for ch in changes:
        before = ""
        pid = first_printing.get(ch["id"], {}).get("id")
        if ch["kind"] != "added" and pid and (faces / f"{pid}.png").exists():
            before = f'<img src="{b64(faces / (pid + ".png"))}">'
        after = f'<img src="{after_imgs[ch["id"]]}">' if ch["id"] in after_imgs else ""
        rows = "".join(f'<li><code>{e(f["field"])}</code>: <span class="old">{e(str(f["from"]))}</span> → <span class="new">{e(str(f["to"]))}</span></li>' for f in ch["fields"])
        badge = {"changed": "~ changed", "added": "+ added", "removed": "− removed"}[ch["kind"]]
        changes_html += f'''<div class="change"><h3>{e(ch["name"])} <span class="badge {ch["kind"]}">{badge}</span></h3>
        <div class="beforeafter"><div><div class="lbl">before</div>{before}</div><div><div class="lbl">after</div>{after}</div>
        <ul class="fieldlist">{rows}</ul></div></div>'''
    if not changes_html:
        changes_html = "<p class='muted'>No comparison loaded. The platform shows every version's changes here — like a pull request, but the diff is cards.</p>"

    formats_html = ""
    for f in formats:
        r = restrictions.get(f.get("active_restriction_id") or "")
        pool = ", ".join(sets_[s]["name"] for s in f["card_pool"] if s in sets_)
        rest = ""
        if r:
            b = ", ".join(cards_by_id[c]["name"] for c in (r.get("banned") or []) if c in cards_by_id) or "none"
            s = ", ".join(cards_by_id[c]["name"] for c in (r.get("restricted") or []) if c in cards_by_id) or "none"
            rest = f'''<div class="restriction"><strong>{e(r.get("name", r["id"]))}</strong> <span class="muted">effective {e(str(r.get("date_start")))}</span>
            <div>Banned: {e(b)} · Restricted: {e(s)}</div>
            {f'<blockquote>{e(r["notes"])}</blockquote>' if r.get("notes") else ""}</div>'''
        formats_html += f'<div class="fmt"><h3>{e(f["name"])}</h3><div class="muted">Card pool: {e(pool)}</div>{rest}</div>'

    decks_html = ""
    for d, legal, lines in deck_results:
        cardlist = ", ".join(f'{n}× {e(cards_by_id[cid]["name"])}' for cid, n in d["cards"].items() if cid in cards_by_id)
        verdict = '<span class="legal">LEGAL</span>' if legal else '<span class="illegal">ILLEGAL</span>'
        detail = "".join(f"<div class='muted small'>{e(l)}</div>" for l in lines if l.strip().startswith("ILLEGAL"))
        decks_html += f'<div class="deck"><h3>{e(d["name"])} {verdict}</h3><div class="small">{cardlist}</div>{detail}</div>'
    decks_html = decks_html or "<p class='muted'>No decks yet.</p>"

    page = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{e(game["title"])}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{{--fg:#1c1c1e;--acc:#8c2f1b;--bg:#faf7f2;--card:#fff;--mut:#777}}
body{{font-family:-apple-system,'Segoe UI',sans-serif;margin:0;background:var(--bg);color:var(--fg)}}
header{{background:var(--acc);color:#fff;padding:28px 32px}}
header h1{{margin:0 0 4px;font-size:28px}} .meta{{opacity:.85;font-size:14px}}
.pill{{display:inline-block;background:rgba(255,255,255,.2);border-radius:20px;padding:2px 12px;margin-right:6px;font-size:12px}}
.actions{{margin-top:14px}} .btn{{background:#fff;color:var(--acc);border:none;border-radius:8px;padding:8px 18px;font-weight:700;cursor:pointer;margin-right:8px}}
.btn.ghost{{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.6)}}
nav{{display:flex;gap:4px;padding:0 24px;background:#fff;border-bottom:1px solid #e5e0d8;position:sticky;top:0}}
nav button{{background:none;border:none;padding:14px 16px;font-size:14px;cursor:pointer;border-bottom:2.5px solid transparent;color:var(--mut)}}
nav button.on{{color:var(--acc);border-bottom-color:var(--acc);font-weight:600}}
main{{padding:24px 32px;max-width:1100px;margin:0 auto}} section{{display:none}} section.on{{display:block}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px}}
.tile img{{width:100%;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.12)}}
.tile .tname{{font-size:13px;text-align:center;margin-top:6px;color:var(--mut)}}
.change{{background:var(--card);border-radius:12px;padding:16px 20px;margin-bottom:18px;box-shadow:0 1px 6px rgba(0,0,0,.07)}}
.beforeafter{{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}}
.beforeafter img{{width:190px;border-radius:8px}} .lbl{{font-size:11px;text-transform:uppercase;color:var(--mut);margin-bottom:4px}}
.fieldlist{{list-style:none;padding:0;font-size:14px}} .fieldlist li{{margin:6px 0}}
.old{{background:#fde8e8;text-decoration:line-through;padding:1px 6px;border-radius:4px}}
.new{{background:#e5f5e0;padding:1px 6px;border-radius:4px}}
.badge{{font-size:11px;border-radius:12px;padding:2px 10px;vertical-align:middle}}
.badge.changed{{background:#fff3cd}} .badge.added{{background:#e5f5e0}} .badge.removed{{background:#fde8e8}}
.fmt,.deck,.restriction{{background:var(--card);border-radius:12px;padding:14px 20px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,.07)}}
blockquote{{border-left:3px solid var(--acc);margin:8px 0 0;padding:4px 12px;color:#555;font-size:14px}}
.legal{{color:#1c7a2e;font-size:13px;border:1.5px solid #1c7a2e;border-radius:12px;padding:1px 10px}}
.illegal{{color:#b3261e;font-size:13px;border:1.5px solid #b3261e;border-radius:12px;padding:1px 10px}}
.muted{{color:var(--mut)}} .small{{font-size:13px}}
footer{{padding:24px 32px;color:var(--mut);font-size:13px;text-align:center}}
</style></head><body>
<header><h1>{e(game["title"])}</h1>
<div class="meta">v{e(str(game.get("version","0.1")))} · {e(game.get("description","")[:140])}</div>
<div style="margin-top:10px"><span class="pill">📄 {lic}</span><span class="pill">✋ provenance: {e(prov)}</span>
<span class="pill">🃏 {len(cards)} cards · {len(printings)} printings · {len(sets_)} sets</span>
{f'<span class="pill">⑂ remix of {e(attr["source_title"])}</span>' if attr else ''}</div>
<div class="actions"><button class="btn" onclick="alert('On the platform: one click creates your fork with the attribution chain intact — then every tool here works on YOUR copy.')">⑂ Remix this game</button>
<button class="btn ghost" onclick="alert('Exports run from the same data: PnP PDF, Tabletop Simulator, CSV.')">⤓ Export</button></div></header>
<nav><button class="on" data-t="cards">Cards</button><button data-t="changes">Changes</button>
<button data-t="formats">Formats &amp; Banlist</button><button data-t="decks">Decks</button></nav>
<main>
<section id="cards" class="on"><div class="grid">{''.join(card_tile(c) for c in cards)}</div></section>
<section id="changes"><h2>Proposed changes <span class="muted small">(balance-2026-07 vs main)</span></h2>{changes_html}</section>
<section id="formats">{formats_html}</section>
<section id="decks">{decks_html}</section>
</main>
<footer>Generated from open format data by build_site.py — the same files that print the PnP PDF and build the TTS mod render this page.</footer>
<script>
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{{
document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
document.querySelectorAll('section').forEach(x=>x.classList.remove('on'));
b.classList.add('on');document.getElementById(b.dataset.t).classList.add('on');}});
</script></body></html>"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page)
    print(f"Site: {out_path}  ({out_path.stat().st_size//1024} KB, self-contained)")

if __name__ == "__main__":
    main()
