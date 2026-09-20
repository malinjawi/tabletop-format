/** Read-only comparison of Store 2, sealed release bytes, and Store 1 tags.
 * Run in an operator process/worker, never on the HTTP event loop. A live
 * observation is not a synchronized backup: writers must be quiescent before
 * accepting the resulting evidence for backup or restore.
 */
import { isDeepStrictEqual } from "node:util";

const queries = {
  users: "SELECT id FROM users ORDER BY id",
  games: "SELECT slug, project_id, namespace, repo_slug, repo_id FROM games ORDER BY slug",
  releases: "SELECT * FROM releases ORDER BY game_slug, tag",
  bindings: "SELECT * FROM release_artifact_vaults ORDER BY game_slug, release_tag",
  journals: "SELECT * FROM pending_release_publications ORDER BY game_slug, release_tag",
  events: "SELECT id, kind, actor_id, game_slug, target, created_at FROM events ORDER BY id",
};

export function readPublicationInventorySqlite(db) {
  db.exec("BEGIN");
  try {
    const result = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, db.prepare(sql).all()]));
    db.exec("COMMIT"); return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function readPublicationInventoryPostgres(db) {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    /** @type {Record<string, any[]>} */
    const result = {};
    for (const [name, sql] of Object.entries(queries)) result[name] = (await client.query(sql)).rows;
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

const key = (slug, tag) => JSON.stringify([slug, tag]);
const json = value => value == null ? null : JSON.parse(value);
const compact = items => items.filter(item => item.status === "ready" || item.blob)
  .map(({name, bytes, sha256}) => ({name, bytes, sha256})).sort((a,b) => a.name.localeCompare(b.name));
const tagMessage = (slug, tag, sha, digest, metadata) =>
  `${metadata.title || tag}\n\n${metadata.notes || "- (initial release)"}\n\nForge project: ${slug}\nExact source: ${sha}\nForge artifact vault: sha256:${digest}`;

export async function auditPublicationInventory({ inventory, vault, store }) {
  const vaultReport = vault.audit(), entries = new Map();
  const entryFor = (slug, tag) => {
    const id = key(slug, tag);
    if (!entries.has(id)) entries.set(id, {slug, tag, findings:[]});
    return entries.get(id);
  };
  const finding = (entry, classification, code) => entry.findings.push({classification, code});
  for (const [collection, property, tagField] of [["releases","release","tag"],
    ["bindings","binding","release_tag"],["journals","journal","release_tag"]]) {
    for (const row of inventory[collection]) {
      const entry = entryFor(row.game_slug, row[tagField]);
      if (entry[property]) finding(entry,"contradictory",`duplicate-${property}`);
      entry[property] = row;
    }
  }
  for (const manifest of vaultReport.manifests) entryFor(manifest.slug,manifest.tag).vault = manifest;
  const events = new Map(inventory.events.map(event => [event.id,event]));
  const users = new Set(inventory.users.map(user => user.id));
  const games = new Set(inventory.games.map(game => game.slug));
  const eventReservations = new Map(inventory.journals.map(row => [row.event_id,key(row.game_slug,row.release_tag)]));
  const sealedEventOwners = new Map();
  for (const entry of entries.values()) {
    const {slug,tag,release,binding,journal} = entry;
    if (!games.has(slug)) finding(entry,"missing","project-index");
    let preserved = null;
    try { preserved = vault.readManifest({slug,tag}); vault.readRelease({slug,tag}); }
    catch(error) { finding(entry, error.code === "VAULT_MISSING" ? "missing" : "contradictory", "sealed-release-unavailable"); }
    const manifest = preserved?.manifest, publication = manifest?.publication;
    const source = manifest?.release.source_sha || release?.sha || journal?.source_sha;
    entry.source_sha = source || null;
    if (release && !binding) finding(entry,"missing","database-vault-binding");
    if (binding && !release) finding(entry,"contradictory","binding-without-finalized-release");
    if (journal?.finalized_at != null && !release) finding(entry,"contradictory","finalized-journal-without-release");
    if (release && journal?.finalized_at === null) finding(entry,"contradictory","finalized-release-with-pending-journal");

    if (manifest) {
      for (const [row, prefix] of [[binding,""],[journal,"vault_"]]) {
        if (!row) continue;
        if (Number(row[`${prefix}format_version`]) !== manifest.version
          || row[`${prefix}manifest_sha256`] !== preserved.manifestSha256)
          finding(entry,"contradictory","database-manifest-binding");
        if (!["tag-manifest","db-receipt"].includes(row[`${prefix}binding_kind`]))
          finding(entry,"contradictory","unsupported-binding-kind");
        if (publication && (row[`${prefix}binding_kind`] !== "tag-manifest"
          || Number(row[`${prefix}sealed_at`]) !== publication.sealed_at))
          finding(entry,"contradictory","native-seal-binding");
      }
      for (const row of [release,journal].filter(Boolean)) {
        if ((row.sha || row.source_sha) !== source) finding(entry,"contradictory","source-identity");
        try {
          const artifacts = json(row.artifacts_json);
          if (!Array.isArray(artifacts) || !isDeepStrictEqual(compact(artifacts),compact(manifest.artifacts)))
            finding(entry,"contradictory","artifact-receipts");
          if (publication) {
            const expected = publication.release;
            if (Number(row.created_at) !== publication.created_at
              || ["title","notes","author_id"].some(field => (row[field] ?? null) !== (expected[field] ?? null))
              || !isDeepStrictEqual(artifacts,expected.artifacts)
              || !isDeepStrictEqual(json(row.rights_json),expected.rights)
              || !isDeepStrictEqual(json(row.build_json),expected.build))
              finding(entry,"contradictory","sealed-publication-metadata");
          }
        } catch { finding(entry,"contradictory","unreadable-database-metadata"); }
      }
      if (publication) {
        const expected = publication.event, actual = events.get(expected.id);
        const priorSeal = sealedEventOwners.get(expected.id);
        if (priorSeal && priorSeal !== entry) {
          finding(priorSeal,"contradictory","event-reserved-by-multiple-seals");
          finding(entry,"contradictory","event-reserved-by-multiple-seals");
        } else sealedEventOwners.set(expected.id,entry);
        if (!users.has(publication.release.author_id)) finding(entry,"missing","publisher-account");
        if (eventReservations.has(expected.id) && eventReservations.get(expected.id) !== key(slug,tag))
          finding(entry,"contradictory","publication-event-reserved-elsewhere");
        if (journal && (journal.event_id !== expected.id || journal.event_kind !== expected.kind
          || journal.event_actor_id !== expected.actor_id)) finding(entry,"contradictory","journal-event-binding");
        if (release && !journal) finding(entry,"missing","native-publication-journal");
        if (release && !actual) finding(entry,"missing","publication-event");
        if (actual && (!release || actual.kind !== expected.kind || actual.actor_id !== expected.actor_id
          || actual.game_slug !== slug || actual.target !== tag || Number(actual.created_at) !== publication.created_at))
          finding(entry,"contradictory","publication-event-binding");
      }
    }
    try {
      if (!source || await store.resolveRef(slug,source) !== source) finding(entry,"missing","source-revision");
    } catch { finding(entry,"unavailable","source-revision-unverified"); }
    let liveTag, tagReadFailed = false;
    try { liveTag = await store.releaseTagInfo(slug,tag); }
    catch { tagReadFailed = true; finding(entry,"unavailable","repository-tag-unverified"); }
    const native = !!publication || binding?.binding_kind === "tag-manifest" || journal?.vault_binding_kind === "tag-manifest";
    if (liveTag) {
      if (liveTag.target !== source) finding(entry,"contradictory","tag-source-binding");
      if (native) {
        const metadata = publication?.release || release || journal;
        if (!liveTag.annotated || !liveTag.protected || !/^[a-f0-9]{40}$/.test(liveTag.tagObject || "")
          || (preserved && String(liveTag.message || "").trimEnd() !== tagMessage(slug,tag,source,preserved.manifestSha256,metadata).trimEnd()))
          finding(entry,"contradictory","protected-tag-manifest-binding");
        if (release && (!release.tag_annotated || !release.tag_protected || release.tag_object_sha !== liveTag.tagObject))
          finding(entry,"contradictory","recorded-tag-object-binding");
      }
    } else if (release && !tagReadFailed) finding(entry,"missing","repository-tag");
    if (!release && manifest) {
      if (publication || journal) finding(entry,"recoverable",journal?"prepared-publication":"sealed-before-journal");
      else finding(entry,"unreferenced","legacy-manifest-without-publication");
    }
  }
  const precedence = ["contradictory","missing","unavailable","unreferenced","recoverable"];
  const publications = [...entries.values()].map(({slug,tag,source_sha,findings}) =>
    ({slug,tag,source_sha,classification:precedence.find(kind => findings.some(item => item.classification === kind)) || "healthy",findings}))
    .sort((a,b) => key(a.slug,a.tag).localeCompare(key(b.slug,b.tag)));
  return {format:"forge-publication-inventory",version:1,
    ok:vaultReport.ok && publications.every(entry => ["healthy","recoverable"].includes(entry.classification)),
    consistency:"Read-only observation; synchronized backup acceptance additionally requires stopped writers.",
    counts:Object.fromEntries(["healthy","recoverable","missing","contradictory","unavailable","unreferenced"]
      .map(kind => [kind,publications.filter(entry => entry.classification === kind).length])),
    publications,vault:vaultReport};
}
