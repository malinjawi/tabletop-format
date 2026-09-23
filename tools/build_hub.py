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
import base64, hashlib, html, json, mimetypes, os, posixpath, re, subprocess, sys, tempfile
from urllib.parse import quote
from pathlib import Path
import yaml

from design_engines import design_engines_metadata, load_design_engines
from creator_help import creator_help

ROOT = Path(__file__).resolve().parent.parent
GIT_ROOT = ROOT
LIVE_ASSETS = False
RUNTIME_GAME_SLUG = None
RUNTIME_SOURCE_REF = None

FIXTURES_DIR = "_fixtures"

def discover_games(base=None, include_fixtures=False):
    """Any directory with a game.yaml is a game — no hard-coded list.

    Scans direct children of `base`. Internal regression fixtures are included
    only when a local test or private proof explicitly opts in.
    """
    base = Path(base) if base else ROOT / "examples"
    # A hosted top-level game is the canonical path. A same-slug fixture may
    # still exist for regression tests, but must not create a duplicate route
    # whose first entry wins unpredictably in the SPA's G(slug) lookup.
    games = {p.parent.name: p.parent for p in base.glob("*/game.yaml")}
    fixtures = base / FIXTURES_DIR
    if include_fixtures and fixtures.is_dir():
        for child in sorted(fixtures.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue  # skip files (e.g. PHASE1-REPORT.md) and dotdirs
            gy = child / "game.yaml"
            if gy.exists() and child.name not in games:
                games[child.name] = child
    return sorted(games.values())

def sh(args, cwd=None, ok_fail=False):
    r = subprocess.run(args, cwd=cwd or GIT_ROOT, capture_output=True, text=True)
    if r.returncode and not ok_fail: raise RuntimeError(r.stderr)
    return r.stdout.strip() if not r.returncode else None

def b64(p): return "data:image/png;base64," + base64.b64encode(Path(p).read_bytes()).decode()

def data_uri(p):
    p = Path(p)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"

def runtime_asset(gd, path):
    """Return one game asset as a self-contained URI or a live Store-1 URL."""
    path, assets = Path(path).resolve(), (Path(gd) / "assets").resolve()
    try: rel = path.relative_to(assets).as_posix()
    except ValueError: return data_uri(path)
    if LIVE_ASSETS:
        stat = path.stat()
        version = f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
        slug = RUNTIME_GAME_SLUG or Path(gd).name
        exact = f"ref={quote(RUNTIME_SOURCE_REF, safe='')}&" if RUNTIME_SOURCE_REF else ""
        return f"/api/games/{quote(slug, safe='')}/assets/{quote(rel, safe='/')}?{exact}v={version}"
    return data_uri(path)

def game_file(gd, rel, label):
    """Resolve one contributor-declared path without letting it leave the game."""
    path, base = (gd / rel).resolve(), gd.resolve()
    try: path.relative_to(base)
    except ValueError: raise ValueError(f"{label} escapes the game directory: {rel}")
    if not path.is_file(): raise ValueError(f"{label} does not exist: {rel}")
    return path

def load_production(gd):
    """Load the renderer-neutral production contract and self-contain its SVGs."""
    path = gd / "templates" / "production.json"
    if not path.exists(): return None
    production = json.loads(path.read_text())
    for template in production.get("templates") or []:
        svg_path = game_file(gd, template.get("template", ""), "production template")
        if svg_path.suffix.lower() != ".svg":
            raise ValueError(f"production template must be SVG: {template.get('template')}")
        source = svg_path.read_text()
        for resource in template.get("resources") or []:
            resource_path = game_file(gd, resource, "production resource")
            reference = posixpath.relpath(resource_path.as_posix(), svg_path.parent.as_posix())
            # Live snapshots intentionally retain LFS pointers. Address the
            # resource through the exact Store-1 asset route instead of
            # embedding pointer text as if it were the image or font bytes.
            uri = runtime_asset(gd, resource_path) if LIVE_ASSETS else data_uri(resource_path)
            # SVG editors emit both href="..." and CSS url("..."). Replacing
            # the exact declared relative reference handles both while keeping
            # undeclared paths visible to validation instead of silently reading them.
            source = source.replace(f'"{reference}"', f'"{uri}"').replace(f"'{reference}'", f"'{uri}'")
        template["template_svg"] = source
    return production

# rules.md images ("BOOK ENGINE" -- tools/hub_template.html rbCompile()):
# ![caption](path) / ![caption|left](path) resolve `path` against the
# game's OWN assets/ dir (the same convention printings.json "art"/"back"
# and game.yaml symbol "asset" fields already use) and get embedded as
# base64 data URIs, exactly like card faces/scans above -- so a built
# hub.html (or the print rulebook window) needs zero extra network
# requests to show a rules diagram. Capped per-file so one huge scan
# doesn't bloat every game's page load; oversized/missing/external
# (http(s)/data:) references are left as plain paths -- rbFigure() in
# hub_template.html falls back to the raw path if no embed exists for it.
RULES_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
RULES_ASSET_MAX_BYTES = 300 * 1024

def embed_rules_assets(gd, rules_md):
    out = {}
    for path in RULES_IMG_RE.findall(rules_md or ""):
        if path in out or re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*:)?//", path) or path.startswith("data:"):
            continue  # already embedded, or an external/absolute URL -- leave those to the browser
        fp = gd / path
        try:
            resolved, base = fp.resolve(), gd.resolve()
            resolved.relative_to(base)  # raises if path escapes the game dir (e.g. "../../etc")
        except (OSError, ValueError):
            continue
        if not resolved.is_file():
            print(f"  ! rules.md image not found, leaving as plain path: {path}", file=sys.stderr)
            continue
        size = resolved.stat().st_size
        if not LIVE_ASSETS and size > RULES_ASSET_MAX_BYTES:
            print(f"  ! rules.md image too big to embed ({size}B > {RULES_ASSET_MAX_BYTES}B cap), "
                  f"leaving as plain path: {path}", file=sys.stderr)
            continue
        if LIVE_ASSETS:
            out[path] = runtime_asset(gd, resolved)
        else:
            mime = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
            out[path] = f"data:{mime};base64,{base64.b64encode(resolved.read_bytes()).decode()}"
    return out

def load_rulebook_publication(gd):
    """Load one portable designed publication for the visual rules workspace."""
    manifest_rel = Path("rules/publications/manifest.json")
    manifest_path = gd / manifest_rel
    if not manifest_path.exists(): return None
    registry = json.loads(manifest_path.read_text())
    active = next((item for item in registry.get("publications", [])
                   if item.get("id") == registry.get("active")), None)
    if not active: return None
    source_rel = Path(active.get("source", ""))
    source_path = (gd / source_rel).resolve()
    try: source_path.relative_to(gd.resolve())
    except ValueError: raise ValueError(f"rulebook publication source escapes game: {source_rel}")
    if not source_path.is_file(): raise ValueError(f"rulebook publication source missing: {source_rel}")
    publication_root = source_path.parent
    source_files = [manifest_rel.as_posix()] + [
        path.relative_to(gd).as_posix() for path in publication_root.rglob("*") if path.is_file()
    ]
    return {
        "version": registry.get("version"), "active": registry.get("active"),
        "manifest_path": manifest_rel.as_posix(), "source_path": source_rel.as_posix(),
        "publication": active, "document": json.loads(source_path.read_text()),
        "source_files": sorted(set(source_files)),
    }

def load_pnp_package(gd):
    """Load an immutable publisher PnP package and verify its semantic baseline."""
    manifest_path = gd / "assets" / "official-pnp" / "manifest.json"
    if not manifest_path.exists(): return None
    manifest = json.loads(manifest_path.read_text())
    pdf = manifest.get("print_pdf") or {}
    pdf_path = game_file(gd, pdf.get("path", ""), "official PnP PDF")
    baseline_current = True
    for rel, expected in (manifest.get("baseline_files") or {}).items():
        source = game_file(gd, rel, "official PnP baseline file")
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        baseline_current = baseline_current and actual == expected
    return {
        "title": manifest.get("title") or "Official Print & Play",
        "kind": manifest.get("kind"),
        "license": manifest.get("license"),
        "attribution": manifest.get("attribution"),
        "source_url": manifest.get("source_url"),
        "source_sha256": manifest.get("source_sha256"),
        "pages": pdf.get("pages"),
        "page_size": pdf.get("page_size"),
        "url": runtime_asset(gd, pdf_path),
        "baseline_current": baseline_current,
        "production_assets": manifest.get("production_assets") or {},
    }

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

def git_history(scope_rel, cards_rel, limit=15, ref="HEAD"):
    log = sh(["git", "log", f"-{limit}", "--format=%H|%h|%an|%as|%s", ref, "--", scope_rel], ok_fail=True)
    if not log: return []
    entries = []
    for line in log.split("\n"):
        full, short, author, date, subject = line.split("|", 4)
        now = cards_at(full, cards_rel) or []
        prev = cards_at(f"{full}^", cards_rel) or []
        entries.append({"sha": short, "author": author, "date": date, "subject": subject,
                        "introduced": len(now) if not prev else 0,
                        "changes": diff_cards(prev, now) if prev else []})
    return entries

def render_ref_faces(game_rel, ref, want_ids):
    """Render card faces for a git ref; return {card_id: dataURI} for first printings."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "g"
        rel = f"{game_rel}/components/cards.json"
        tracked = sh(["git", "ls-tree", "-r", "--name-only", ref, "--", game_rel], ok_fail=True)
        if not tracked or rel not in tracked.splitlines(): return {}
        # A branch preview is an immutable project snapshot, not today's tree
        # with only cards.json swapped in. Materialize every tracked game file
        # at the requested ref so cards, printings, layouts, fonts, and artwork
        # can never be mixed across versions.
        tmp.mkdir(parents=True)
        prefix = f"{game_rel}/"
        for source_path in tracked.splitlines():
            if not source_path.startswith(prefix): continue
            target = tmp / source_path[len(prefix):]
            target.parent.mkdir(parents=True, exist_ok=True)
            content = subprocess.run(["git", "show", f"{ref}:{source_path}"], cwd=GIT_ROOT,
                                     capture_output=True, check=True).stdout
            target.write_bytes(content)
        rendered = subprocess.run(["node", str(ROOT / "tools/render_cards.mjs"), str(tmp), str(tmp / "f2")],
                                  capture_output=True, text=True)
        if rendered.returncode:
            detail = (rendered.stderr or rendered.stdout or "unknown renderer failure").strip()
            raise RuntimeError(f"could not render {game_rel} at {ref}: {detail}")
        printings = json.loads((tmp / "components/printings.json").read_text())
        first = {}
        for p in printings: first.setdefault(p["card_id"], p["id"])
        out = {}
        for cid in want_ids:
            f = tmp / "f2" / f"{first.get(cid, '')}.png"
            if f.exists(): out[cid] = b64(f)
        return out

def build_game(gd, route_slug=None, git_rel=None, history_ref="HEAD"):
    gd = Path(gd).resolve()
    slug = route_slug or gd.name  # Store-1 compatibility key; public identity is namespace/repo_slug.
    project = {}
    project_path = gd / "forge" / "project.json"
    if project_path.exists():
        try: project = json.loads(project_path.read_text())
        except Exception: project = {}
    namespace = project.get("namespace") or "community"
    repo_slug = project.get("slug") or slug
    project_id = project.get("project_id") or f"legacy:{slug}"
    # games can live OUTSIDE the platform repo (forgejo-backend checkout farm,
    # scratch dirs): git-derived views degrade gracefully instead of crashing
    if git_rel is not None: game_rel = git_rel
    else:
        try: game_rel = str(gd.relative_to(GIT_ROOT))
        except ValueError: game_rel = None
    game = yaml.safe_load((gd / "game.yaml").read_text())
    symbols = []
    for symbol in game.get("symbols") or []:
        runtime_symbol = dict(symbol)
        asset = symbol.get("asset")
        if asset:
            asset_path = gd / asset
            if asset_path.is_file(): runtime_symbol["asset_data"] = runtime_asset(gd, asset_path)
        symbols.append(runtime_symbol)
    cards = json.loads((gd / "components/cards.json").read_text())
    printings = json.loads((gd / "components/printings.json").read_text())
    for printing in printings:
        art = printing.get("art")
        if art and not re.match(r"^(?:data:|https?:|file:)", art, re.I):
            art_path = gd / art
            if art_path.is_file(): printing["art_data"] = runtime_asset(gd, art_path)
    # layout: OPTIONAL declarative print-true card layout (templates/layout.yaml,
    # schemas/layout.schema.json) -- read straight through to the client payload
    # as plain data; layoutCard() (tools/hub_template.html) is what interprets
    # it. Absent for most games today -- they keep rendering via cardFrame().
    layout_path = gd / "templates" / "layout.yaml"
    layout = yaml.safe_load(layout_path.read_text()) if layout_path.exists() else None
    if layout:
        for font in layout.get("fonts") or []:
            local_asset = font.get("local_asset")
            local_path = gd / local_asset if local_asset else None
            asset = local_asset if local_path and local_path.is_file() else font.get("asset")
            if asset and not re.match(r"^(?:data:|https?:|file:)", asset, re.I):
                asset_path = gd / asset
                if asset_path.is_file(): font["asset_data"] = runtime_asset(gd, asset_path)
        back_art = (layout.get("back") or {}).get("art")
        if back_art and not re.match(r"^(?:data:|https?:|file:)", back_art, re.I):
            back_art_path = gd / back_art
            if back_art_path.is_file(): layout["back"]["art_data"] = runtime_asset(gd, back_art_path)
    def normalize_card_design_layout(value):
        value = dict(value)
        value["fonts"] = [dict(font) for font in value.get("fonts") or []]
        for font in value["fonts"]:
            local_asset = font.get("local_asset")
            local_path = gd / local_asset if local_asset else None
            asset = local_asset if local_path and local_path.is_file() else font.get("asset")
            if asset and not re.match(r"^(?:data:|https?:|file:)", asset, re.I):
                asset_path = gd / asset
                if asset_path.is_file(): font["asset_data"] = runtime_asset(gd, asset_path)
        if value.get("back"):
            value["back"] = dict(value["back"])
            back_art = value["back"].get("art")
            if back_art and not re.match(r"^(?:data:|https?:|file:)", back_art, re.I):
                back_art_path = gd / back_art
                if back_art_path.is_file(): value["back"]["art_data"] = runtime_asset(gd, back_art_path)
        return value
    design_engines = load_design_engines(gd, normalize_card_design_layout)
    card_design = design_engines.get("card_design") if design_engines else None
    if not layout and card_design and card_design.get("families"):
        layout = card_design["families"][0]["layout"]
    source_overlay_path = gd / "templates" / "source-overlay.yaml"
    source_overlay = yaml.safe_load(source_overlay_path.read_text()) if source_overlay_path.exists() else None
    source_assets = {}
    if source_overlay:
        for region in source_overlay.get("regions") or []:
            for asset in (region.get("patches") or {}).values():
                if re.match(r"^(?:data:|https?:|file:)", asset, re.I): continue
                asset_path = gd / asset
                if asset_path.is_file() and asset not in source_assets:
                    source_assets[asset] = runtime_asset(gd, asset_path)
            render = region.get("render") or {}
            for asset_key in ("font_asset", "background_asset"):
                asset = render.get(asset_key)
                if asset and not re.match(r"^(?:data:|https?:|file:)", asset, re.I):
                    asset_path = gd / asset
                    if asset_path.is_file() and asset not in source_assets:
                        source_assets[asset] = runtime_asset(gd, asset_path)
    production = load_production(gd)
    pnp_package = load_pnp_package(gd)
    sets_ = load_dir(gd, "sets"); formats = load_dir(gd, "formats")
    restrictions = load_dir(gd, "restrictions"); decks = load_dir(gd, "decks")
    setups = load_dir(gd, "setups")
    for setup in setups:
        board = setup.get("board") or {}
        background = board.get("background")
        if background and background.startswith("assets/"):
            background_path = game_file(gd, background, "setup board background")
            board["background_data"] = runtime_asset(gd, background_path)
    faces = gd / "exports" / "faces"
    first = {}
    for p in printings: first.setdefault(p["card_id"], p)
    images = {}
    for c in cards:
        # The live server renders cards from semantic data and only needs one
        # lightweight discovery thumbnail. Exact PR comparisons are added
        # below for their changed card ids. Static hubs keep all baked faces.
        if LIVE_ASSETS and images: break
        pid = first.get(c["id"], {}).get("id")
        f = faces / f"{pid}.png"
        if pid and f.exists(): images[c["id"]] = b64(f)
    # scans: composed source faces, local PnP crop preferred over an external URL.
    # Parallel to `images` (our rendered/editable faces) so the hub can show BOTH.
    scans = {}
    for c in cards:
        printing = first.get(c["id"], {})
        local = printing.get("scan")
        local_path = gd / local if local else None
        if local_path and local_path.is_file():
            # Keep the embedded/static payload in one place.  layoutCard() can
            # resolve printing.scan_data through g.scans, while the headless
            # renderer supplies printing.scan_data directly.  Duplicating the
            # same PnP face in both objects roughly doubled large static hubs.
            scans[c["id"]] = runtime_asset(gd, local_path)
        elif printing.get("image"):
            scans[c["id"]] = printing["image"]

    rel = f"{game_rel}/components/cards.json" if game_rel else None
    history = git_history(game_rel, rel, ref=history_ref) if rel else []

    # Rules can use the backwards-compatible Markdown renderer or declare a
    # native production pipeline in rules/pipeline.yaml. The browser receives
    # only metadata and safe repository paths; actual builds stay server-side.
    rules_md = (gd / "rules" / "rules.md").read_text() if (gd / "rules" / "rules.md").exists() else ""
    rulebook_publication = load_rulebook_publication(gd)
    rulebook_pipeline = None
    pipeline_path = gd / "rules" / "pipeline.yaml"
    if pipeline_path.exists():
        registry = yaml.safe_load(pipeline_path.read_text()) or {}
        active = next((p for p in registry.get("pipelines", []) if p.get("id") == registry.get("active")), None)
        if active:
            overlay_root = active.get("overlay_root")
            overlay_files = []
            if overlay_root and (gd / overlay_root).is_dir():
                overlay_files = sorted(p.relative_to(gd).as_posix() for p in (gd / overlay_root).rglob("*") if p.is_file())
            rulebook_pipeline = {
                "version": registry.get("version"), "active": registry.get("active"),
                "manifest_path": "rules/pipeline.yaml", "pipeline": active,
                "overlay_files": overlay_files,
                "source_lock": f"git:{(active.get('source') or {}).get('url', '')}#{(active.get('source') or {}).get('ref', '')}",
            }
    rules_log = (sh(["git", "log", "-10", "--format=%h|%an|%as|%s", history_ref, "--", f"{game_rel}/rules"], ok_fail=True) or "") if game_rel else ""
    rules_history = [dict(zip(["sha", "author", "date", "subject"], l.split("|", 3)))
                     for l in rules_log.split("\n") if l]
    tokens = []
    tk = gd / "components" / "tokens.json"
    if tk.exists():
        tokens = json.loads(tk.read_text())
        # Piece Studio uses the same source paths in live and self-contained
        # hubs.  Live payloads resolve those paths through the exact-ref asset
        # route; static hubs need the bytes embedded because `/api/games/...`
        # does not exist when the file is opened offline.
        for token in tokens:
            for face in [token, token.get("back") or {}, *(token.get("faces") or [])]:
                art = face.get("art")
                if art and not re.match(r"^(?:data:|https?:|file:)", art, re.I):
                    art_path = game_file(gd, art, "component art")
                    face["art_data"] = runtime_asset(gd, art_path)
    component_design = None
    cd = gd / "templates" / "component-design.json"
    if cd.exists(): component_design = json.loads(cd.read_text())
    playtests = load_dir(gd, "playtests")
    playtests.sort(key=lambda s: s.get("date", ""), reverse=True)
    community = {}
    cy = gd / "community.yaml"
    if cy.exists(): community = yaml.safe_load(cy.read_text()) or {}
    design_md = ""
    dn = gd / "design" / "notes.md"
    if dn.exists(): design_md = md_to_html(dn.read_text())
    design_brief = None
    db = gd / "design" / "brief.json"
    if db.exists(): design_brief = json.loads(db.read_text())
    prototype = None
    dp = gd / "design" / "prototype.json"
    if dp.exists(): prototype = json.loads(dp.read_text())
    # merged credit roll (same logic as fmt credits, inline)
    people = {}
    for c in community.get("contributors") or []:
        people[c["name"]] = {"roles": set(c["roles"]), "commits": 0, "sessions": 0}
    authors = ((sh(["git", "log", "--format=%an", history_ref, "--", game_rel], ok_fail=True) or "").splitlines()) if game_rel else []
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
    if not rel: branches = []
    for br in branches:
        if br in ("", "main"): continue
        base = cards_at(history_ref, rel); head = cards_at(br, rel)
        if not base or not head: continue
        changes = diff_cards(base, head)
        if not changes: continue
        author = sh(["git", "log", "-1", "--format=%an", br], ok_fail=True) or "?"
        subject = sh(["git", "log", "-1", "--format=%s", br], ok_fail=True) or br
        changed_ids = sorted({c["card"] for c in changes})
        after = render_ref_faces(game_rel, br, changed_ids)
        prs.append({"branch": br, "author": author, "title": subject, "changes": changes,
                    "after": after})
    # The cards grid/modal/editor already render live with layoutCard(). Do not
    # rasterize every face merely to build the hub: `images` is only needed by
    # static PR before/after screenshots and jam thumbnails. Existing export
    # faces remain useful for thumbnails; a static PR renders only its touched
    # main-branch cards through the canonical renderer.
    if prs and game_rel:
        current_ids = sorted({ch["card"] for pr in prs for ch in pr["changes"]})
        images.update(render_ref_faces(game_rel, history_ref, current_ids))

    # releases (tags touching this file's history — keep simple: all tags with notes)
    releases = []
    for t in (sh(["git", "tag"], ok_fail=True) or "").split("\n"):
        if not t: continue
        notes = sh(["git", "tag", "-l", "--format=%(contents)", t], ok_fail=True) or ""
        date = sh(["git", "log", "-1", "--format=%as", t], ok_fail=True) or ""
        releases.append({"tag": t, "date": date, "notes": notes})

    last_commit = history[0] if history else None
    return {
        "slug": slug, "namespace": namespace, "repo_slug": repo_slug,
        "project_id": project_id,
        "slug_path": f"{quote(str(namespace), safe='')}/{quote(str(repo_slug), safe='')}",
        "title": game.get("title", repo_slug), "description": game.get("description", ""),
        "license": game.get("license", "?"), "version": game.get("version", ""),
        "players": game.get("players") or {},
        "provenance": (game.get("default_provenance") or {}).get("source", "?"),
        "authors": [a.get("name") for a in (game.get("authors") or [])],
        "attribution": game.get("attribution"),
        "cards": cards, "printings": printings, "images": images, "scans": scans,
        "layout": layout, "card_design": card_design,
        "design_engines": design_engines_metadata(design_engines),
        "source_overlay": source_overlay, "source_assets": source_assets,
        "production": production,
        "pnp_package": pnp_package,
        "schema": game.get("attribute_definitions") or [],
        "card_types": game.get("card_types"),
        "type_colors": game.get("type_colors") or {},
        "faction_colors": game.get("faction_colors") or {},
        "card_style": game.get("card_style"),
        "book_style": game.get("book_style"),
        "official_docs": game.get("official_docs") or [],
        "symbols": symbols,
        "sets": sets_, "formats": formats, "restrictions": restrictions,
        "decks": deck_data, "setups": setups, "history": history, "prs": prs, "releases": releases,
        "rules_html": md_to_html(rules_md), "rules_md": rules_md, "rules_assets": embed_rules_assets(gd, rules_md),
        "rulebook_pipeline": rulebook_pipeline, "rulebook_publication": rulebook_publication,
        "rules_history": rules_history, "tokens": tokens, "component_design": component_design,
        "playtests": playtests,
        "community": community, "design_html": design_md, "design_brief": design_brief,
        "prototype": prototype,
        "credit_roll": credit_roll,
        "updated": last_commit["date"] if last_commit else "",
        "ncards": len(cards), "nprintings": len(printings), "nsetups": len(setups),
    }

def load_jams():
    jams = []
    jd = ROOT / "jams"
    if jd.is_dir():
        for f in sorted(jd.glob("*.yaml")):
            jams.append(yaml.safe_load(f.read_text()))
    return jams

def build_people(games, jams):
    """User profiles are COMPUTED from git + playtests + credits — no accounts needed for read."""
    people = {}
    def P(name):
        return people.setdefault(name, {"name": name, "roles": set(), "games": {},
                                        "commits": 0, "sessions": 0, "entries": []})
    for g in games:
        for p in g["credit_roll"]:
            e = P(p["name"])
            e["roles"] |= set(p["roles"])
            e["commits"] += p["commits"]; e["sessions"] += p["sessions"]
            e["games"][g["slug"]] = {"slug": g["slug"], "title": g["title"],
                                     "roles": p["roles"], "commits": p["commits"], "sessions": p["sessions"]}
        for h in g["history"]:
            if h["author"] not in people and h["author"]:
                e = P(h["author"]); e["roles"].add("developer")
    for j in jams:
        for entry in j.get("entries") or []:
            e = P(entry["author"])
            e["entries"].append({"jam": j["title"], "jam_id": j["id"], "game": entry["title"],
                                 "award": entry.get("award")})
    return [{**p, "roles": sorted(p["roles"]), "games": list(p["games"].values())}
            for p in people.values()]

def main():
    global GIT_ROOT, LIVE_ASSETS, RUNTIME_GAME_SLUG, RUNTIME_SOURCE_REF
    args = sys.argv[1:]
    if "--repo-root" in args:
        GIT_ROOT = Path(args[args.index("--repo-root") + 1]).resolve()
    LIVE_ASSETS = "--live-assets" in args
    if "--game-json" in args:
        gd = Path(args[args.index("--game-json") + 1]).resolve()
        route_slug = args[args.index("--route-slug") + 1] if "--route-slug" in args else None
        git_rel = args[args.index("--git-rel") + 1] if "--git-rel" in args else None
        history_ref = args[args.index("--history-ref") + 1] if "--history-ref" in args else "HEAD"
        RUNTIME_GAME_SLUG, RUNTIME_SOURCE_REF = route_slug, history_ref if history_ref != "HEAD" else None
        print(json.dumps(build_game(gd, route_slug=route_slug, git_rel=git_rel, history_ref=history_ref)).replace("</", "<\\/"))
        return
    out_path = Path(args[args.index("-o") + 1]) if "-o" in args else ROOT / "hub.html"
    base = args[args.index("--games") + 1] if "--games" in args else None
    include_fixtures = "--include-fixtures" in args
    if include_fixtures and os.environ.get("NODE_ENV") == "production":
        raise SystemExit("production cannot include internal test fixtures")
    jams = load_jams()
    games = [] if "--shell" in args else [
        build_game(g) for g in discover_games(base, include_fixtures)
    ]
    data = {"games": games, "jams": jams, "people": build_people(games, jams), "help": creator_help(ROOT)}
    data_js = json.dumps(data).replace("</", "<\\/")
    tpl = (ROOT / "tools" / "hub_template.html").read_text()
    out_path.write_text(tpl.replace("__DATA__", data_js))
    print(f"Hub: {out_path}  ({out_path.stat().st_size // 1024} KB, {len(data['games'])} games, self-contained)")

if __name__ == "__main__":
    main()
