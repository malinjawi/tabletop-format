export const ART_LIBRARY_MANIFEST = "design/art-library.json";

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = value => value == null ? null : structuredClone(value);

export function emptyArtLibrary() {
  return { format: "forge-art-library", version: 1, assets: [] };
}

export function parseArtLibrary(bytes) {
  if (!bytes) return emptyArtLibrary();
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`${ART_LIBRARY_MANIFEST} is not valid JSON`); }
  if (value?.format !== "forge-art-library" || value?.version !== 1 || !Array.isArray(value.assets))
    throw new Error(`unsupported ${ART_LIBRARY_MANIFEST} format`);
  if (value.assets.length > 10000) throw new Error(`${ART_LIBRARY_MANIFEST} contains more than 10000 records`);
  const seen = new Set();
  for (const record of value.assets) {
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.path !== "string")
      throw new Error(`${ART_LIBRARY_MANIFEST} has an invalid artwork record`);
    if (Object.keys(record).some(key => !["path", "tags"].includes(key))
      || !/^assets\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(record.path)
      || record.path.includes("..") || record.path.includes("//"))
      throw new Error(`${ART_LIBRARY_MANIFEST} has an unsafe or unsupported path '${record.path}'`);
    if (!Array.isArray(record.tags) || record.tags.length > 24
      || new Set(record.tags).size !== record.tags.length
      || record.tags.some(tag => typeof tag !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(tag)))
      throw new Error(`${ART_LIBRARY_MANIFEST} has invalid tags for '${record.path}'`);
    if (seen.has(record.path)) throw new Error(`${ART_LIBRARY_MANIFEST} repeats '${record.path}'`);
    seen.add(record.path);
  }
  return clone(value);
}

export function artLibraryBytes(value) {
  const library = parseArtLibrary(Buffer.from(JSON.stringify(value)));
  library.assets.sort((a, b) => a.path.localeCompare(b.path));
  for (const record of library.assets) record.tags = [...record.tags].sort();
  return JSON.stringify(library, null, 2) + "\n";
}

/** Three-way merge independent artwork records by permanent repository path. */
export function mergeArtLibrary(base, proposed, current) {
  const baseByPath = new Map(parseArtLibrary(Buffer.from(JSON.stringify(base))).assets.map(record => [record.path, record]));
  const proposedByPath = new Map(parseArtLibrary(Buffer.from(JSON.stringify(proposed))).assets.map(record => [record.path, record]));
  const currentByPath = new Map(parseArtLibrary(Buffer.from(JSON.stringify(current))).assets.map(record => [record.path, record]));
  const merged = [], conflicts = [];
  for (const path of [...new Set([...baseByPath.keys(), ...proposedByPath.keys(), ...currentByPath.keys()])].sort()) {
    const before = baseByPath.get(path) ?? null, draft = proposedByPath.get(path) ?? null, head = currentByPath.get(path) ?? null;
    if (equal(draft, before)) { if (head) merged.push(clone(head)); continue; }
    if (equal(head, before) || equal(head, draft)) { if (draft) merged.push(clone(draft)); continue; }
    conflicts.push({ path, before: clone(before), proposed: clone(draft), current: clone(head) });
    if (head) merged.push(clone(head));
  }
  return { merged: { format: "forge-art-library", version: 1, assets: merged }, conflicts };
}

export function diffArtLibrary(before, after) {
  const left = new Map(parseArtLibrary(Buffer.from(JSON.stringify(before))).assets.map(record => [record.path, record]));
  const right = new Map(parseArtLibrary(Buffer.from(JSON.stringify(after))).assets.map(record => [record.path, record]));
  const changed = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (equal(left.get(path), right.get(path))) continue;
    changed.push({ path, kind: !left.has(path) ? "added" : !right.has(path) ? "removed" : "changed",
      before: clone(left.get(path) ?? null), after: clone(right.get(path) ?? null) });
  }
  return changed;
}
