"""Bundle the two maintained creator guides into live and offline Forge help."""
import html
import posixpath
import re
from urllib.parse import quote

GUIDES = {"creator": "CREATOR-GUIDE.md", "connectors": "CONNECTORS.md"}


def help_link(target):
    for key, filename in GUIDES.items():
        if target == filename:
            return "#help" if key == "creator" else "#help/connectors"
    path = posixpath.normpath(posixpath.join("docs", target))
    if path.startswith("../") or ":" in target or target.startswith("/"):
        return None
    return "https://github.com/malinjawi/tabletop-format/blob/main/" + quote(path, safe="/#")


def inline(source):
    # Escape all document text; only the explicit guide formatting creates HTML.
    parts = []
    for token in re.split(r"(`[^`]+`|\[[^\]]+\]\([^)]+\))", source):
        link = re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", token)
        if token.startswith("`") and token.endswith("`"):
            parts.append("<code>" + html.escape(token[1:-1]) + "</code>")
        elif link and (url := help_link(link[2])):
            parts.append(f'<a href="{html.escape(url, quote=True)}">{html.escape(link[1])}</a>')
        else:
            parts.append(re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(token)))
    return "".join(parts)


def render_guide(source):
    lines, out, i = source.splitlines(), [], 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("|"):
            rows, headers = [], []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = lines[i].strip().strip("|").split("|")
                if not all(re.fullmatch(r"\s*:?-+:?\s*", cell) for cell in cells):
                    tag = "th" if not rows else "td"
                    if not rows:
                        headers = [cell.strip() for cell in cells]
                    row = '<tr class="help-table-header">' if tag == "th" else "<tr>"
                    for index, cell in enumerate(cells):
                        label = f' data-label="{html.escape(headers[index], quote=True)}"' if tag == "td" and index < len(headers) else ""
                        row += f"<{tag}{label}>{inline(cell.strip())}</{tag}>"
                    rows.append(row + "</tr>")
                i += 1
            out.append('<div class="help-table" tabindex="0" aria-label="Guide comparison"><table>' + "".join(rows) + "</table></div>")
            continue
        heading = re.match(r"^(#{1,3}) (.+)$", line)
        if heading:
            level = len(heading[1])
            out.append(f"<h{level}>{inline(heading[2])}</h{level}>")
        elif re.match(r"^(- |\d+\. )", line):
            ordered = not line.startswith("- ")
            tag = "ol" if ordered else "ul"
            items = []
            pattern = r"^\d+\. (.*)$" if ordered else r"^- (.*)$"
            while i < len(lines) and (item := re.match(pattern, lines[i].strip())):
                items.append("<li>" + inline(item[1]) + "</li>")
                i += 1
            out.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
            continue
        else:
            out.append("<p>" + inline(line) + "</p>")
        i += 1
    return "\n".join(out)


def creator_help(root):
    return {key: render_guide((root / "docs" / filename).read_text()) for key, filename in GUIDES.items()}
