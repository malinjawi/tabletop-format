#!/usr/bin/env node
/** sync-check.mjs — asserts the spine: sheet → versioned commit → every export. */
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
  body: JSON.stringify({ title: "Sync Game", csv: "name,type,text,cost\nSpark,unit,Deal 1 damage.,1\nWall,unit,Blocks.,2" }) })).json();
ok(g.slug === "sync-game", "game hosted from a CSV");

ok((await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: sheet }) })).status === 401, "anonymous cannot connect a source (401)");
ok((await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(bob.token), body: JSON.stringify({ url: sheet }) })).status === 403, "a non-collaborator cannot connect a source (403)");
const html = await j(await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ url: sheet.replace("/sheet.csv", "/html") }) }));
ok(html.s === 422 && /CSV|published/i.test(html.d.error), "an UNPUBLISHED sheet is refused with a helpful message");

const conn = await j(await fetch(`${base}/api/games/${g.slug}/sync/sheet`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ url: sheet }) }));
ok(conn.s === 200 && conn.d.cards === 2, "connect the published sheet");
ok((await j(await fetch(`${base}/api/games/${g.slug}/sync`))).d.connected === true, "sync status reports the connection");
ok((await j(await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token) }))).d.message === "already in sync", "no changes → no empty commit");

// art + credit assigned BEFORE the sync must survive it
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");
await fetch(`${base}/api/games/${g.slug}/assets?path=assets/art/spark.png`, { method: "POST", headers: { Authorization: "Bearer " + alice.token }, body: png });
await fetch(`${base}/api/games/${g.slug}/art`, { method: "PUT", headers: A(alice.token), body: JSON.stringify({ printing_id: "p_spark_core", art: "assets/art/spark.png", artist: "Rae Ember" }) });

await setSheet("name,type,text,cost\nSpark,unit,Deal 2 damage.,1\nWall,unit,Blocks.,2\nTorch,unit,Deal 1 to all.,3");
const dry = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull?dry=1`, { method: "POST", headers: A(alice.token) }));
ok(dry.s === 200 && dry.d.dry && dry.d.changes.length === 2, "DRY pull previews the changes");
ok((await (await fetch(`${base}/api/games/${g.slug}/cards`)).json()).length === 2, "a dry run changes nothing");
const pull = await j(await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token) }));
ok(pull.s === 200 && pull.d.saved && pull.d.commit, `pull → ONE validated commit (${pull.d.summary})`);
const cards = await (await fetch(`${base}/api/games/${g.slug}/cards`)).json();
ok(cards.length === 3 && cards.find(c => c.id === "spark").text === "Deal 2 damage.", "the game matches the sheet");

const exp = await j(await fetch(`${base}/api/games/${g.slug}/export/tts`, { method: "POST", headers: A(alice.token) }));
const tts = await (await fetch(base + exp.d.urls[0])).json();
ok(tts.ObjectStates[0].ContainedObjects.some(o => o.Nickname === "Torch"), "THE SPINE: a card added in the SHEET appears in the TTS mod");
ok((await fetch(`${base}/api/games/${g.slug}/export/ttc`, { method: "POST", headers: A(alice.token) })).status === 200, "the Tabletop Club pack regenerates");
ok((await fetch(`${base}/api/games/${g.slug}/export/pnp`, { method: "POST", headers: A(alice.token) })).status === 200, "the print-and-play PDF regenerates");

const hist = await (await fetch(`${base}/api/games/${g.slug}/history`)).json();
ok(/sync: pull/.test(hist[0].subject) && hist[0].author === "alice", "the pull is a normal, attributed commit in the history");

await setSheet("name,type,text,cost\n");
ok((await fetch(`${base}/api/games/${g.slug}/sync/pull`, { method: "POST", headers: A(alice.token) })).status === 422, "an EMPTIED sheet is refused — never silently wipes a game");
ok((await (await fetch(`${base}/api/games/${g.slug}/cards`)).json()).length === 3, "the game is intact after the refused pull");

console.log(fail ? `\nSYNC FAILED — ${fail} failure(s)` : `\nSYNC GREEN — ${n} checks. The sheet is the source of truth; every output follows.`);
process.exit(fail ? 1 : 0);
