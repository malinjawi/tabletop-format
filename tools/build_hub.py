#!/usr/bin/env python3
"""build_hub.py - GitHub-style hub UI for designers (Block I flagship prototype).
Usage: python3 tools/build_hub.py [-o hub.html]     (run from inside the git repo)

Generates a self-contained SPA from REAL repo data:
  Explore page (all example games) -> repo pages with GitHub-style tabs:
  Overview | Cards (searchable grid, card modal w/ PER-CARD history) |
  History (git log as card changes) | Suggestions (branches as PRs with
  before/after card art) | Releases (tags) | Banlist | Decks (live legality).
Everything is baked at build time from git + format data. No server.
"""
import base64, html, json, subprocess, sys, tempfile
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent

def discover_games(base=None):
    """Any directory with a game.yaml is a game — no hard-coded list."""
    base = Path(base) if base else ROOT / "examples"
    return sorted(p.parent for p in base.glob("*/game.yaml"))

def sh(args, cwd=ROOT, ok_fail=False):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode and not ok_fail: raise RuntimeError(r.stderr)
    return r.stdout.strip() if not r.returncode else None

def b64(p): return "data:image/png;base64," + base64.b64encode(Path(p).read_bytes()).decode()

def load_dir(gd, d):
    p = gd / d
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

def diff_cards(old, new):
    o = {c["id"]: c for c in old}; n = {c["id"]: c for c in new}
    out = []
    for cid, oc in o.items():
        nc = n.get(cid)
        if not nc: out.append({"card": cid, "name": oc["name"], "kind": "removed"}); continue
        of, nf = flatten(oc), flatten(nc)
        for k in sorted(set(of) | set(nf)):
            if of.get(k) != nf.get(k):
                out.append({"card": cid, "name": nc["name"], "kind": "changed",
                            "field": k, "from": of.get(k), "to": nf.get(k)})
    for cid, nc in n.items():
        if cid not in o: out.append({"card": cid, "name": nc["name"], "kind": "added"})
    return out

def cards_at(ref, rel):
    out = sh(["git", "show", f"{ref}:{rel}"], ok_fail=True)
    return json.loads(out) if out else None

def md_to_html(md):
    """Tiny markdown renderer: headings, bold/italic, lists, paragraphs, symbols stay as [x]."""
    out, in_list, in_ol = [], False, False
    for raw in md.split("\n"):
        line = raw.rstrip()
        def inline(s):
            s = html.escape(s)
            import re as _re
            s = _re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
            s = _re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
            s = _re.sub(r"`(.+?)`", r"<code>\1</code>", s)
            return s
        if line.startswith("#"):
            if in_list: out.append("</ul>"); in_list = False
            if in_ol: out.append("</ol>"); in_ol = False
            n = len(line) - len(line.lstrip("#"))
            out.append(f"<h{min(n,4)}>{inline(line.lstrip('# '))}</h{min(n,4)}>")
        elif line.startswith("- "):
            if in_ol: out.append("</ol>"); in_ol = False
            if not in_list: out.append("<ul>"); in_list = True
            out.append(f"<li>{inline(line[2:])}</li>")
        elif line[:3].rstrip(". ").isdigit() and ". " in line[:4]:
            if in_list: out.append("</ul>"); in_list = False
            if not in_ol: out.append("<ol>"); in_ol = True
            out.append(f"<li>{inline(line.split('. ', 1)[1])}</li>")
        elif line == "":
            if in_list: out.append("</ul>"); in_list = False
            if in_ol: out.append("</ol>"); in_ol = False
        else:
            out.append(f"<p>{inline(line)}</p>")
    if in_list: out.append("</ul>")
    if in_ol: out.append("</ol>")
    return "\n".join(out)

def git_history(rel, limit=15):
    log = sh(["git", "log", f"-{limit}", "--format=%H|%h|%an|%as|%s", "--", rel], ok_fail=True)
    if not log: return []
    entries = []
    for line in log.split("\n"):
        full, short, author, date, subject = line.split("|", 4)
        now = cards_at(full, rel) or []
        prev = cards_at(f"{full}^", rel) or []
        entries.append({"sha": short, "author": author, "date": date, "subject": subject,
                        "introduced": len(now) if not prev else 0,
                        "changes": diff_cards(prev, now) if prev else []})
    return entries

def render_ref_faces(game_rel, ref, want_ids):
    """Render card faces for a git ref; return {card_id: dataURI} for first printings."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "g"
        subprocess.run(["cp", "-r", str(ROOT / game_rel), str(tmp)], check=True)
        rel = f"{game_rel}/components/cards.json"
        content = sh(["git", "show", f"{ref}:{rel}"], ok_fail=True)
        if not content: return {}
        (tmp / "components/cards.json").write_text(content)
        subprocess.run([sys.executable, str(ROOT / "tools/render_cards.py"), str(tmp), str(tmp / "f2")],
                       check=True, capture_output=True)
        printings = json.loads((tmp / "components/printings.json").read_text())
        first = {}
        for p in printings: first.setdefault(p["card_id"], p["id"])
        out = {}
        for cid in want_ids:
            f = tmp / "f2" / f"{first.get(cid, '')}.png"
            if f.exists(): out[cid] = b64(f)
        return out

def build_game(gd):
    gd = Path(gd)
    slug = gd.name
    game_rel = str(gd.relative_to(ROOT))
    game = yaml.safe_load((gd / "game.yaml").read_text())
    cards = json.loads((gd / "components/cards.json").read_text())
    printings = json.loads((gd / "components/printings.json").read_text())
    sets_ = load_dir(gd, "sets"); formats = load_dir(gd, "formats")
    restrictions = load_dir(gd, "restrictions"); decks = load_dir(gd, "decks")
    faces = gd / "exports" / "faces"
    if not faces.is_dir():
        subprocess.run([sys.executable, str(ROOT / "tools/render_cards.py"), str(gd)], check=True, capture_output=True)
    first = {}
    for p in printings: first.setdefault(p["card_id"], p)
    images = {}
    for c in cards:
        pid = first.get(c["id"], {}).get("id")
        f = faces / f"{pid}.png"
        if pid and f.exists(): images[c["id"]] = b64(f)

    rel = f"{game_rel}/components/cards.json"
    history = git_history(rel)

    # rules: rendered markdown + its own git history (errata trail)
    rules_md = (gd / "rules" / "rules.md").read_text() if (gd / "rules" / "rules.md").exists() else ""
    rules_rel = f"{game_rel}/rules/rules.md"
    rules_log = sh(["git", "log", "-10", "--format=%h|%an|%as|%s", "--", rules_rel], ok_fail=True) or ""
    rules_history = [dict(zip(["sha", "author", "date", "subject"], l.split("|", 3)))
                     for l in rules_log.split("\n") if l]
    tokens = []
    tk = gd / "components" / "tokens.json"
    if tk.exists(): tokens = json.loads(tk.read_text())
    playtests = load_dir(gd, "playtests")
    playtests.sort(key=lambda s: s.get("date", ""), reverse=True)
    community = {}
    cy = gd / "community.yaml"
    if cy.exists(): community = yaml.safe_load(cy.read_text()) or {}
    design_md = ""
    dn = gd / "design" / "notes.md"
    if dn.exists(): design_md = md_to_html(dn.read_text())
    # merged credit roll (same logic as fmt credits, inline)
    people = {}
    for c in community.get("contributors") or []:
        people[c["name"]] = {"roles": set(c["roles"]), "commits": 0, "sessions": 0}
    authors = (sh(["git", "log", "--format=%an", "--", game_rel], ok_fail=True) or "").splitlines()
    for a in authors:
        a = a.strip()
        if not a: continue
        people.setdefault(a, {"roles": set(), "commits": 0, "sessions": 0})
        people[a]["commits"] += 1
        people[a]["roles"].add("developer")
    for s in playtests:
        for pl in s.get("players") or []:
            people.setdefault(pl["name"], {"roles": set(), "commits": 0, "sessions": 0})
            people[pl["name"]]["sessions"] += 1
            people[pl["name"]]["roles"].add("playtester")
    credit_roll = [{"name": n, "roles": sorted(p["roles"]), "commits": p["commits"], "sessions": p["sessions"]}
                   for n, p in people.items()]

    # deck legality via checker
    deck_data = []
    ddir = gd / "decks"
    if ddir.is_dir():
        for f in sorted(ddir.glob("*.json")):
            d = json.loads(f.read_text())
            r = subprocess.run([sys.executable, str(ROOT / "tools/check_deck.py"), str(gd), str(f)],
                               capture_output=True, text=True)
            d["_legal"] = r.returncode == 0
            d["_violations"] = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("ILLEGAL")]
            deck_data.append(d)

    # branches as PRs (any branch whose cards.json differs from main)
    prs = []
    branches = (sh(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"], ok_fail=True) or "").split("\n")
    for br in branches:
        if br in ("", "main"): continue
        base = cards_at("main", rel); head = cards_at(br, rel)
        if not base or not head: continue
        changes = diff_cards(base, head)
        if not changes: continue
        author = sh(["git", "log", "-1", "--format=%an", br], ok_fail=True) or "?"
        subject = sh(["git", "log", "-1", "--format=%s", br], ok_fail=True) or br
        changed_ids = sorted({c["card"] for c in changes})
        after = render_ref_faces(game_rel, br, changed_ids)
        prs.append({"branch": br, "author": author, "title": subject, "changes": changes,
                    "after": after})

    # releases (tags touching this file's history — keep simple: all tags with notes)
    releases = []
    for t in (sh(["git", "tag"], ok_fail=True) or "").split("\n"):
        if not t: continue
        notes = sh(["git", "tag", "-l", "--format=%(contents)", t], ok_fail=True) or ""
        date = sh(["git", "log", "-1", "--format=%as", t], ok_fail=True) or ""
        releases.append({"tag": t, "date": date, "notes": notes})

    last_commit = history[0] if history else None
    return {
        "slug": slug, "title": game.get("title", slug), "description": game.get("description", ""),
        "license": game.get("license", "?"), "version": game.get("version", ""),
        "provenance": (game.get("default_provenance") or {}).get("source", "?"),
        "authors": [a.get("name") for a in (game.get("authors") or [])],
        "attribution": game.get("attribution"),
        "cards": cards, "images": images,
        "sets": sets_, "formats": formats, "restrictions": restrictions,
        "decks": deck_data, "history": history, "prs": prs, "releases": releases,
        "rules_html": md_to_html(rules_md), "rules_history": rules_history, "tokens": tokens,
        "playtests": playtests,
        "community": community, "design_html": design_md, "credit_roll": credit_roll,
        "updated": last_commit["date"] if last_commit else "",
        "ncards": len(cards), "nprintings": len(printings),
    }

def main():
    args = sys.argv[1:]
    out_path = Path(args[args.index("-o") + 1]) if "-o" in args else ROOT / "hub.html"
    base = args[args.index("--games") + 1] if "--games" in args else None
    data = {"games": [build_game(g) for g in discover_games(base)]}
    data_js = json.dumps(data).replace("</", "<\\/")
    tpl = (ROOT / "tools" / "hub_template.html").read_text()
    out_path.write_text(tpl.replace("__DATA__", data_js))
    print(f"Hub: {out_path}  ({out_path.stat().st_size // 1024} KB, {len(data['games'])} games, self-contained)")

if __name__ == "__main__":
    main()
