import { isDeepStrictEqual } from "node:util";

const MISSING = Symbol("missing");
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => a === MISSING || b === MISSING ? a === b : isDeepStrictEqual(a, b);

function get(value, path) {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

function leafPaths(...values) {
  const out = [];
  const visit = (candidates, prefix) => {
    const objects = candidates.map(value => value !== MISSING && value != null
      && typeof value === "object" && !Array.isArray(value));
    // A whole object appeared or disappeared. Treat that parent as the changed
    // leaf so the merge deletes/replaces it atomically instead of walking its
    // old children and leaving an invalid empty shell.
    if (prefix.length && objects.some(Boolean) && !objects.every(Boolean)) {
      out.push(prefix);
      return;
    }
    if (!objects.every(Boolean)) {
      if (prefix.length) out.push(prefix);
      return;
    }
    const keys = new Set(candidates.flatMap(value => Object.keys(value)));
    if (!keys.size && prefix.length) out.push(prefix);
    for (const key of keys) visit(candidates.map(value => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : MISSING), [...prefix, key]);
  };
  visit(values, []);
  return out;
}

function set(value, path, next) {
  for (const key of path.slice(0, -1)) value = value[key] ||= {};
  if (next === MISSING) delete value[path.at(-1)]; else value[path.at(-1)] = clone(next);
}

/** Three-way merge stable-id rows while preserving non-overlapping field edits. */
export function mergeRows(baseRows, proposedRows, currentRows, kind) {
  const by = rows => new Map(rows.map(row => [row.id, row]));
  const base = by(baseRows), proposed = by(proposedRows), current = by(currentRows);
  const merged = currentRows.map(clone), mergedBy = by(merged), conflicts = [];
  const ids = new Set([...base.keys(), ...proposed.keys()]);
  for (const id of ids) {
    const b = base.get(id) ?? MISSING, p = proposed.get(id) ?? MISSING, c = current.get(id) ?? MISSING;
    if (equal(b, p)) continue;
    if (b === MISSING || p === MISSING) {
      if (equal(c, p)) continue;
      if (!equal(c, b)) { conflicts.push({ kind, id, path: "*", base: b === MISSING ? null : b, proposed: p === MISSING ? null : p, current: c === MISSING ? null : c }); continue; }
      if (p === MISSING) {
        const index = merged.findIndex(row => row.id === id); if (index >= 0) merged.splice(index, 1);
        mergedBy.delete(id);
      } else { const next = clone(p); merged.push(next); mergedBy.set(id, next); }
      continue;
    }
    const target = mergedBy.get(id);
    for (const path of leafPaths(b, p)) {
      const bv = get(b, path), pv = get(p, path);
      if (equal(bv, pv)) continue;
      const cv = get(c, path);
      if (equal(cv, pv)) continue;
      if (!equal(cv, bv)) {
        conflicts.push({ kind, id, path: path.join("."), base: bv === MISSING ? null : bv, proposed: pv === MISSING ? null : pv, current: cv === MISSING ? null : cv });
        continue;
      }
      set(target, path, pv);
    }
  }
  return { merged, conflicts };
}

/** Summarize stable-id row changes without exposing implementation details. */
export function diffRows(before, after, kind = "rows") {
  const b = new Map(before.map(row => [row.id, row])), a = new Map(after.map(row => [row.id, row]));
  const changed = [], added = [], removed = [];
  for (const [id, row] of b) {
    if (!a.has(id)) removed.push(id);
    else if (!isDeepStrictEqual(row, a.get(id))) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) added.push(id);
  return { kind, changed, added, removed };
}
