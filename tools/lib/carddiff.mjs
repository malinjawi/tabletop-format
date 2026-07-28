// @ts-check
/**
 * carddiff.mjs — shared semantic diff engine (Block C). ZERO dependencies.
 * @typedef {{id:string,name:string,type:string,subtypes?:string[],text?:string,
 *            keywords?:string[],attributes?:Record<string,number|string|boolean>,
 *            deck_limit?:number}} Card
 * @typedef {{kind:"changed",card:string,name:string,field:string,from:unknown,to:unknown}
 *          |{kind:"added"|"removed",card:string,name:string}} Change
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

/**
 * mergeCards(base, proposed, current) — card-level three-way merge.
 * base     = target when the PR was opened
 * proposed = the fork's cards (what the PR wants)
 * current  = target now (may have moved on)
 *
 * Per card id: if the PR changed it and the target hasn't → apply; if the
 * target already matches the proposal → no-op; if BOTH changed it → conflict.
 * Cards the PR didn't touch are left exactly as `current` has them.
 * Returns { merged, conflicts:[card ids] }.
 */
export function mergeCards(base, proposed, current) {
  const by = (arr) => Object.fromEntries(arr.map(c => [c.id, c]));
  const B = by(base), P = by(proposed), C = by(current);
  const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const conflicts = [];
  const merged = current.map(c => ({ ...c }));
  const idx = () => Object.fromEntries(merged.map((c, i) => [c.id, i]));
  for (const id of new Set([...Object.keys(B), ...Object.keys(P)])) {
    if (eq(B[id], P[id])) continue;               // PR does not change this card
    if (eq(C[id], P[id])) continue;               // target already there
    if (!eq(C[id], B[id])) { conflicts.push(id); continue; } // both sides moved
    const i = idx()[id];
    if (!P[id]) { if (i !== undefined) merged.splice(i, 1); }        // deletion
    else if (i === undefined) merged.push({ ...P[id] });             // addition
    else merged[i] = { ...P[id] };                                   // change
  }
  return { merged, conflicts };
}
