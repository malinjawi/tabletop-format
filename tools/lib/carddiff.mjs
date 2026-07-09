/**
 * carddiff.mjs — shared semantic diff engine (Block C). ZERO dependencies.
 * Cards matched by STABLE ID, never position. Consumers: diff.mjs (CLI),
 * git-diff-cards.mjs (git driver), fmt-git.mjs (auto commit messages,
 * history, changelog), and eventually the platform's PR view.
 */
export function flatten(c) {
  const d = {
    name: c.name, type: c.type,
    subtypes: (c.subtypes ?? []).join(", "),
    text: c.text ?? "", keywords: (c.keywords ?? []).join(", "),
    deck_limit: c.deck_limit,
  };
  for (const [k, v] of Object.entries(c.attributes ?? {})) d[`attributes.${k}`] = v;
  return d;
}

export function diffCards(oldArr, newArr) {
  const o = new Map(oldArr.map(c => [c.id, c]));
  const n = new Map(newArr.map(c => [c.id, c]));
  const changes = [];
  for (const [id, oc] of o) {
    const nc = n.get(id);
    if (!nc) { changes.push({ kind: "removed", card: id, name: oc.name }); continue; }
    const of = flatten(oc), nf = flatten(nc);
    for (const k of new Set([...Object.keys(of), ...Object.keys(nf)]))
      if (JSON.stringify(of[k]) !== JSON.stringify(nf[k]))
        changes.push({ kind: "changed", card: id, name: nc.name, field: k, from: of[k], to: nf[k] });
  }
  for (const [id, nc] of n) if (!o.has(id)) changes.push({ kind: "added", card: id, name: nc.name });
  return changes;
}

/** One-line summary + detailed body — the commit message that writes itself. */
export function summarize(changes) {
  if (!changes.length) return null;
  const byCard = new Map();
  for (const ch of changes) {
    if (!byCard.has(ch.card)) byCard.set(ch.card, { name: ch.name, kind: ch.kind, fields: [] });
    if (ch.kind === "changed") { byCard.get(ch.card).kind = "changed"; byCard.get(ch.card).fields.push(ch); }
    else byCard.get(ch.card).kind = ch.kind;
  }
  const added = [...byCard.values()].filter(c => c.kind === "added");
  const removed = [...byCard.values()].filter(c => c.kind === "removed");
  const changed = [...byCard.values()].filter(c => c.kind === "changed");
  const parts = [];
  if (changed.length) parts.push(`changed ${changed.length} card${changed.length > 1 ? "s" : ""} (${changed.slice(0, 3).map(c => c.name).join(", ")}${changed.length > 3 ? ", …" : ""})`);
  if (added.length) parts.push(`added ${added.length} (${added.slice(0, 3).map(c => c.name).join(", ")}${added.length > 3 ? ", …" : ""})`);
  if (removed.length) parts.push(`removed ${removed.length} (${removed.slice(0, 3).map(c => c.name).join(", ")}${removed.length > 3 ? ", …" : ""})`);
  const title = "cards: " + parts.join("; ");
  const body = [...byCard.values()].map(c =>
    c.kind === "changed"
      ? `* ${c.name}: ` + c.fields.map(f => `${f.field.replace("attributes.", "")} ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`).join(", ")
      : `* ${c.name}: ${c.kind}`
  ).join("\n");
  return { title, body };
}

export function formatChanges(changes) {
  if (!changes.length) return "No changes.";
  let out = "", current = null;
  for (const ch of changes) {
    if (ch.card !== current) { out += `\n${ch.name}  (${ch.card})\n`; current = ch.card; }
    if (ch.kind === "added") out += "  + added\n";
    else if (ch.kind === "removed") out += "  - removed\n";
    else out += `  ~ ${ch.field}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}\n`;
  }
  return out.trimEnd();
}
