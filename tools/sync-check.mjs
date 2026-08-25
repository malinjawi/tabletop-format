#!/usr/bin/env node
/** sync-check.mjs — asserts the spine: Sheet draft → reviewed candidate → every export. */
const [base, sheet] = process.argv.slice(2);
const A = t => ({ Authorization: "Bearer " + t, "content-type": "application/json" });
const j = async r => ({ s: r.status, d: await r.json().catch(() => null) });
let n = 0, fail = 0;
const ok = (c, m) => { c ? console.log(`  ✓ ${String(++n).padStart(2)}  ${m}`) : (fail++, console.log(`  ✗ FAIL  ${m}`)); };
const setSheet = b => fetch(sheet.replace("/sheet.csv", "/_set"), { method: "POST", body: b });

const reg = h => fetch(base + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: h, email: `${h}@x.io`, password: "pw123456" }) }).then(r => r.json());
const alice = await reg("alice"), bob = await reg("bob");
const g = await (await fetch(base + "/api/games", { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ title: "Sync Game", csv: "id,name,type,text,cost\nspark,Spark,unit,Deal 1 damage.,1\nwall,Wall,unit,Blocks.,2" }) })).json();
ok(g.slug === "sync-game", "game hosted from a CSV");

ok((await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: sheet }) })).status === 401, "anonymous cannot connect a source (401)");
ok((await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(bob.token), body: JSON.stringify({ url: sheet }) })).status === 403, "a non-collaborator cannot connect a source (403)");
const html = await j(await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ url: sheet.replace("/sheet.csv", "/html") }) }));
ok(html.s === 422 && /CSV|published/i.test(html.d.error), "an UNPUBLISHED sheet is refused with a helpful message");

const conn = await j(await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ url: sheet }) }));
ok(conn.s === 200 && conn.d.cards === 2 && conn.d.identity_safe, "connect the published Sheet with stable row ids");
ok((await j(await fetch(`${base}/api/games/${g.slug}/sync`))).d.connected === true, "sync status reports the connection");
const initiallyClean = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
ok(initiallyClean.s === 200 && initiallyClean.d.status === "clean" && initiallyClean.d.validation.ok, "saved Sheet draft is clean relative to Forge and validates");
ok((await j(await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token) }))).s === 409, "a commit without an exact reviewed candidate is refused");

// art + credit assigned BEFORE the sync must survive it
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");
await fetch(`${base}/api/games/${g.slug}/assets?path=assets/art/spark.png`, { method: "POST", headers: { Authorization: "Bearer " + alice.token }, body: png });
await fetch(`${base}/api/games/${g.slug}/art`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ printing_id: "p_spark_core", art: "assets/art/spark.png", artist: "Rae Ember" }) });

await setSheet("id,name,type,text,cost\nspark,Spark,unit,Deal 2 damage.,1\nwall,Wall,unit,Blocks.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const dry = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
ok(dry.s === 200 && dry.d.dry && dry.d.changes.length === 2 && dry.d.can_commit && dry.d.validation.ok && dry.d.candidate_cards.length === 2 && dry.d.preview.source_hash,
  "check returns semantic + visual candidate data, validation, and an exact commit token");
ok((await (await fetch(`${base}/api/games/${g.slug}/cards`)).json()).length === 2, "a dry run changes nothing");
const pull = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ preview: dry.d.preview, commit_message: "Test Spark and Torch candidate", contributors: ["Rae"] }) }));
ok(pull.s === 200 && pull.d.saved && pull.d.commit && pull.d.commit_message === "Test Spark and Torch candidate",
  `reviewed candidate → ONE intentional commit (${pull.d.summary})`);
const cards = await (await fetch(`${base}/api/games/${g.slug}/cards`)).json();
ok(cards.length === 3 && cards.find(c => c.id === "spark").text === "Deal 2 damage.", "the game matches the sheet");
const synced = await j(await fetch(`${base}/api/games/${g.slug}/sync`));
ok(synced.d.source_hash === dry.d.preview.source_hash && synced.d.base_sha === pull.d.commit,
  "committed candidate remembers both repository base and working-copy fingerprint");

// Independent changes on each side merge. Forge edits Wall while the Sheet edits Spark.
const locallyEdited = structuredClone(cards);
locallyEdited.find(c => c.id === "wall").text = "Blocks twice.";
ok((await fetch(`${base}/api/games/${g.slug}/cards`, { method: "PUT", headers: A(alice.token), body: JSON.stringify(locallyEdited) })).status === 200,
  "make a Forge-side card edit after the first Sheet candidate");
await setSheet("id,name,type,text,cost\nspark,Spark,unit,Deal 3 damage.,1\nwall,Wall,unit,Blocks.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const independent = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
ok(independent.s === 200 && independent.d.conflicts.length === 0 && independent.d.forge_changes.length === 1 && independent.d.sheet_changes.length === 1,
  "independent Forge and Sheet edits three-way merge without conflict");
const independentApply = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?source_hash=${independent.d.preview.source_hash}&head_sha=${independent.d.preview.head_sha}`,
  { method: "POST", headers: A(alice.token) }));
const mergedCards = await (await fetch(`${base}/api/games/${g.slug}/cards`)).json();
ok(independentApply.s === 200 && mergedCards.find(c => c.id === "spark").text === "Deal 3 damage." && mergedCards.find(c => c.id === "wall").text === "Blocks twice.",
  "candidate commit preserves Forge-only edits while importing Sheet-only edits");

// Same-field edits are blocked and expose all three values.
const forgeConflict = structuredClone(mergedCards);
forgeConflict.find(c => c.id === "spark").text = "Forge says four.";
await fetch(`${base}/api/games/${g.slug}/cards`, { method: "PUT", headers: A(alice.token), body: JSON.stringify(forgeConflict) });
await setSheet("id,name,type,text,cost\nspark,Spark,unit,Sheet says five.,1\nwall,Wall,unit,Blocks twice.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const conflict = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
ok(conflict.s === 200 && !conflict.d.can_apply && conflict.d.conflicts.some(c => c.card_id === "spark" && c.field === "text" && c.base === "Deal 3 damage."),
  "same-field divergence returns an explicit base/Forge/Sheet conflict");
const blocked = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?source_hash=${conflict.d.preview.source_hash}&head_sha=${conflict.d.preview.head_sha}`,
  { method: "POST", headers: A(alice.token) }));
ok(blocked.s === 409 && /conflict/i.test(blocked.d.error), "conflicted candidate cannot commit");
ok((await (await fetch(`${base}/api/games/${g.slug}/cards`)).json()).find(c => c.id === "spark").text === "Forge says four.",
  "blocked conflict leaves Forge intact");

// A preview is an optimistic lock over BOTH systems.
await setSheet("id,name,type,text,cost\nspark,Spark,unit,Forge says four.,1\nwall,Wall,unit,Blocks twice.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const stalePreview = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
await setSheet("id,name,type,text,cost\nspark,Spark,unit,Changed after preview.,1\nwall,Wall,unit,Blocks twice.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const stale = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?source_hash=${stalePreview.d.preview.source_hash}&head_sha=${stalePreview.d.preview.head_sha}`,
  { method: "POST", headers: A(alice.token) }));
ok(stale.s === 409 && stale.d.stale === "sheet", "commit refuses a Sheet that changed after review");

await setSheet("id,name,type,text,cost\nspark,Spark,unit,Forge says four.,1\nwall,Wall,unit,Blocks twice.,2\ntorch,Torch,unit,Deal 1 to all.,3");
const staleForgePreview = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
const movedForge = await (await fetch(`${base}/api/games/${g.slug}/cards`)).json();
movedForge.find(c => c.id === "torch").text = "Changed in Forge after preview.";
await fetch(`${base}/api/games/${g.slug}/cards`, { method: "PUT", headers: A(alice.token), body: JSON.stringify(movedForge) });
const staleForge = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?source_hash=${staleForgePreview.d.preview.source_hash}&head_sha=${staleForgePreview.d.preview.head_sha}`,
  { method: "POST", headers: A(alice.token) }));
ok(staleForge.s === 409 && staleForge.d.stale === "forge", "commit refuses Forge HEAD when it changed after review");

const exp = await j(await fetch(`${base}/api/games/${g.slug}/export/tts`, { method: "POST", headers: A(alice.token) }));
const tts = await (await fetch(base + exp.d.urls[0])).json();
ok(tts.ObjectStates[0].ContainedObjects.some(o => o.Nickname === "Torch"), "THE SPINE: a card added in the SHEET appears in the TTS mod");
ok((await fetch(`${base}/api/games/${g.slug}/export/ttc`, { method: "POST", headers: A(alice.token) })).status === 200, "the Tabletop Club pack regenerates");
ok((await fetch(`${base}/api/games/${g.slug}/export/pnp`, { method: "POST", headers: A(alice.token) })).status === 200, "the print-and-play PDF regenerates");

const hist = await (await fetch(`${base}/api/games/${g.slug}/history`)).json();
ok(hist.some(h => /Test Spark and Torch candidate/.test(h.subject) && h.author === "alice"), "the candidate is a normal, attributed commit in history");

await setSheet("id,name,type,text,cost\n");
ok((await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token) })).status === 422, "an EMPTIED sheet is refused — never silently wipes a game");
ok((await (await fetch(`${base}/api/games/${g.slug}/cards`)).json()).length === 3, "the game is intact after the refused pull");

// The bound Apps Script path sends a private active-tab snapshot directly.
const addonGame = await (await fetch(base + "/api/games", { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ title: "Addon Game", csv: "id,name,type,text,cost\nseed,Seed,unit,Grow.,1" }) })).json();
const sourceId = "spreadsheet-123:456";
const addonCsv = "id,name,type,text,cost\nseed,Seed,unit,Grow twice.,1\nbloom,Bloom,unit,Flower.,2\n";
const addonConnect = await j(await fetch(`${base}/api/games/${addonGame.slug}/sync/sheet`, { method: "PUT", headers: A(alice.token),
  body: JSON.stringify({ source_id: sourceId, snapshot_csv: addonCsv }) }));
ok(addonConnect.s === 200 && addonConnect.d.source_mode === "addon", "private Sheet tab attaches from an add-on snapshot without a public URL");
const wrongTab = await j(await fetch(`${base}/api/games/${addonGame.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ source_id: "spreadsheet-123:999", snapshot_csv: addonCsv }) }));
ok(wrongTab.s === 409, "a snapshot from another spreadsheet tab cannot impersonate the attached working copy");
const addonCheck = await j(await fetch(`${base}/api/games/${addonGame.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ source_id: sourceId, snapshot_csv: addonCsv }) }));
ok(addonCheck.s === 200 && addonCheck.d.status === "changes" && addonCheck.d.counts.cards === 2 && addonCheck.d.can_commit,
  "add-on receives an authoritative uncommitted-change status");
const addonCommit = await j(await fetch(`${base}/api/games/${addonGame.slug}/sync/pull`, { method: "POST", headers: A(alice.token),
  body: JSON.stringify({ source_id: sourceId, snapshot_csv: addonCsv, preview: addonCheck.d.preview,
    commit_message: "Try the Bloom package", contributors: ["sheet-coworker"] }) }));
ok(addonCommit.s === 200 && addonCommit.d.saved && addonCommit.d.commit, "add-on commits exactly the checked private-Sheet candidate");

console.log(fail ? `\nSHEETS FAILED — ${fail} failure(s)` : `\nSHEETS GREEN — ${n} checks. Sheets owns drafts; Forge validates and commits exact game candidates.`);
process.exit(fail ? 1 : 0);
