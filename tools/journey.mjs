#!/usr/bin/env node
/**
 * journey.mjs — THE SYSTEM CONFIRMATION. One continuous two-user story with
 * real data, asserting correct data transfer, metadata, auth, and ownership
 * across ALL THREE STORES at every hop. This is what "working" means:
 *
 *   ALICE hosts a brand-new game from her CSV → owns it → uploads art (LFS)
 *   → edits a card → exports to the immutable cache — every commit AUTHORED
 *   AS ALICE. BOB arrives → sees her game (with owner) → stars it → forks it
 *   → edits HIS fork — authored as Bob — while Alice's original is proven
 *   byte-for-byte untouched, and every ledger (git, SQL, cache) agrees.
 *
 * Run via journey.sh (sets up scratch repo + LFS mock + server).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8420";
let step = 0, failed = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}  ${msg}`);
const die = (msg, detail) => { console.error(`  ✗ FAIL @${step + 1}: ${msg}`, detail ?? ""); process.exit(1); };
const assert = (cond, msg, detail) => cond ? ok(msg) : die(msg, detail);
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

/* ---- the LEDGER: where commits actually live. Local mode reads the scratch
 * repo with git; forge mode (FORGE_URL set) asks the forge's API — the SAME
 * assertions then confirm the PRODUCTION Store-1 backend. ---- */
const FORGE = process.env.FORGE_URL
  ? { url: process.env.FORGE_URL.replace(/\/$/, ""), token: process.env.FORGE_TOKEN } : null;
const OWNERS = { "tidepool": "alice", "tidepool-bob": "bob" };
const fapi = async (p) => fetch(`${FORGE.url}/api/v1${p}`, { headers: { Authorization: `token ${FORGE.token}` } });
const lastCommit = async (slug) => {
  if (!FORGE) { const [an, ae, ...s] = git("log", "-1", "--format=%an|%ae|%s").split("|");
                return { an, ae, s: s.join("|") }; }
  const r = await fapi(`/repos/${OWNERS[slug]}/${slug}/commits?limit=1&stat=false&verification=false&files=false`);
  const c = (await r.json())[0];
  return { an: c.commit.author.name, ae: c.commit.author.email, s: c.commit.message.split("\n")[0] };
};
const repoRead = async (slug, rel) => {
  if (!FORGE) return readFileSync(`examples/${slug}/${rel}`, "utf8");
  const r = await fapi(`/repos/${OWNERS[slug]}/${slug}/raw/${rel}?ref=main`);
  return r.ok ? await r.text() : null;
};
const api = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(BASE + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
               ...(body && !raw ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers,
           data: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

const ALICE_CSV = `name,type,text,cost,pull,deck_limit
Riptide,current,"Pull 2. If you're leading, pull 3.",3,2,2
Hermit Crab,dweller,"Shelters: ignore the next current.",1,0,3
Moon Jelly,dweller,"Drifts: copy the last current played.",2,1,2
Anchor,relic,"Your dwellers can't be pulled this tide.",2,0,1
Spring Tide,current,"Everyone pulls 1. You pull 2.",4,2,1
Tidepool Guide,dweller,"Peek at the top 3 tide cards.",1,0,2`;

// a minimal valid PNG (1x1) padded past pointer-size heuristics
const PNG = Buffer.concat([Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"), Buffer.alloc(300, 0)]);

console.log("== ACT 1: Alice hosts a game ==");
const aliceReg = await api("POST", "/api/auth/register",
  { body: { handle: "alice", email: "alice@tidepool.games", password: "correct-horse-1" } });
assert(aliceReg.status === 201 && aliceReg.data.token, "alice registers");
const A = aliceReg.data.token;

const created = await api("POST", "/api/games", { token: A, body: { title: "Tidepool", csv: ALICE_CSV } });
assert(created.status === 201 && created.data.slug === "tidepool" && created.data.cards === 6,
  "POST /api/games → 'tidepool' hosted: 6 cards from her CSV", created.data);
assert(created.data.owner === "alice", "ownership recorded at creation");
{ const c = await lastCommit("tidepool");
  assert(c.an === "alice" && c.ae === "alice@tidepool.games", "creation commit AUTHORED AS ALICE (git ledger)"); }

const noAuth = await api("POST", "/api/games", { body: { title: "Sneaky" } });
assert(noAuth.status === 401, "anonymous cannot host games (401)");

const me1 = await api("GET", "/api/me", { token: A });
assert(me1.data.games.includes("tidepool"), "/api/me lists alice's game (SQL ledger)");

console.log("== ACT 2: Alice works on it ==");
const art = await api("POST", "/api/games/tidepool/assets?path=assets/art/riptide.png",
  { token: A, raw: PNG });
assert(art.status === 200 && art.data.mode === "lfs" && art.data.oid,
  "art uploaded via LFS batch → pointer committed", art.data);
assert((await repoRead("tidepool", "assets/art/riptide.png")).startsWith("version https://git-lfs"),
  "git holds the 3-line pointer, not the binary (Store 1)");
assert(/alice/.test((await lastCommit("tidepool")).an), "asset commit authored as alice");

const artBack = await api("GET", "/api/games/tidepool/assets/art/riptide.png");
assert(artBack.status === 200 && Buffer.compare(artBack.data, PNG) === 0,
  "GET asset materializes from LFS — bytes identical round-trip");

const cards = (await api("GET", "/api/games/tidepool/cards")).data;
cards.find(c => c.id === "riptide").attributes.cost = 4;
const edit = await api("PUT", "/api/games/tidepool/cards", { token: A, body: cards });
assert(edit.status === 200 && edit.data.saved && /Riptide/.test(edit.data.message),
  `edit committed: "${edit.data.message}"`);
assert(/alice/.test((await lastCommit("tidepool")).an), "edit commit authored as alice (not 'web editor')");

const hist = (await api("GET", "/api/games/tidepool/history")).data;
assert(hist[0].author === "alice" && hist[0].changes.some(c => c.card === "riptide"),
  "history endpoint: alice's semantic change on record");

const exp = await api("POST", "/api/games/tidepool/export/tts", { token: A });
assert(exp.status === 200 && exp.data.urls[0].includes(exp.data.ref),
  `export frozen at sha ${exp.data.ref} (Store 3)`);
const cached = await api("GET", exp.data.urls[0]);
assert(cached.status === 200 && cached.headers.get("cache-control").includes("immutable"),
  "cache URL serves with immutable headers");
const tts = Buffer.isBuffer(cached.data) ? JSON.parse(cached.data.toString()) : cached.data;
assert(tts.ObjectStates[0].DeckIDs.length === 6 && tts.SaveName === "Tidepool",
  "cached TTS save is HER game: 6 cards, correct name");

console.log("== ACT 3: Bob arrives ==");
const bobReg = await api("POST", "/api/auth/register",
  { body: { handle: "bob", email: "bob@example.com", password: "correct-horse-2" } });
const B = bobReg.data.token;
assert(bobReg.status === 201, "bob registers");

const listing = (await api("GET", "/api/games")).data;
const tp = listing.find(g => g.slug === "tidepool");
assert(tp && tp.owner_handle === "alice" && tp.cards === 6,
  "bob sees tidepool in the catalog, owner visible (SQL index)");

const star = await api("PUT", "/api/stars/tidepool", { token: B });
assert(star.status === 200 && star.data.stars === 1, "bob stars it → count 1");

const fork = await api("POST", "/api/games/tidepool/fork", { token: B });
assert(fork.status === 201 && fork.data.slug === "tidepool-bob" && fork.data.forked_from === "tidepool",
  "bob forks → tidepool-bob");
{ const c = await lastCommit("tidepool-bob");
  assert(c.an === "bob" && /fork: tidepool/.test(c.s), "fork commit authored by bob"); }
const forkYaml = await repoRead("tidepool-bob", "game.yaml");
assert(/attribution:/.test(forkYaml) && /source_id: tidepool/.test(forkYaml),
  "SPEC §9 attribution block committed into the fork");

console.log("== ACT 4: parallel work, no bleed ==");
const before = await repoRead("tidepool", "components/cards.json");
const bobCards = (await api("GET", "/api/games/tidepool-bob/cards")).data;
bobCards.find(c => c.id === "moon_jelly").text = "Drifts: copy any current in play.";
const bobEdit = await api("PUT", "/api/games/tidepool-bob/cards", { token: B, body: bobCards });
assert(bobEdit.status === 200 && /Moon Jelly/.test(bobEdit.data.message), "bob edits HIS fork");
assert(/bob/.test((await lastCommit("tidepool-bob")).an), "bob's edit authored as bob");
assert(await repoRead("tidepool", "components/cards.json") === before,
  "alice's ORIGINAL byte-for-byte untouched by bob's work");
const aliceHist = (await api("GET", "/api/games/tidepool/history")).data;
assert(aliceHist.every(h => h.author !== "bob"), "no bob commits in alice's history");
const forkValid = (await api("GET", "/api/games/tidepool-bob/validate")).data;
assert(forkValid.ok, "bob's fork validates as a complete game");

console.log("== ACT 5: the remix loop closes — bob proposes, alice merges ==");
const prOpen = await api("POST", "/api/games/tidepool/prs", { token: B,
  body: { from: "tidepool-bob", title: "Moon Jelly drift buff", body: "playtested in my fork" } });
assert(prOpen.status === 201 && prOpen.data.changes.some(c => c.card === "moon_jelly"),
  "bob opens a PR back to tidepool — semantic diff names Moon Jelly", prOpen.data);
const prId = prOpen.data.id;
const noMerge = await api("POST", `/api/games/tidepool/prs/${prId}/merge`, { token: B });
assert(noMerge.status === 403, "bob CANNOT merge into alice's game (owner-only rule)");
const prView = (await api("GET", `/api/games/tidepool/prs/${prId}`, { token: A })).data;
assert(prView.author === "bob" && prView.status === "open" && prView.conflicts.length === 0,
  "alice reviews: bob's PR, open, conflict-free");
const prMerged = await api("POST", `/api/games/tidepool/prs/${prId}/merge`, { token: A });
assert(prMerged.status === 200 && prMerged.data.merged, "alice merges bob's PR", prMerged.data);
const tpCards = (await api("GET", "/api/games/tidepool/cards")).data;
assert(/copy any current in play/.test(tpCards.find(c => c.id === "moon_jelly").text),
  "tidepool now carries bob's change — the remix loop is CLOSED");
assert(/bob/.test((await lastCommit("tidepool")).an), "merge commit authored as BOB (credit follows the work)");
const prAfter = (await api("GET", `/api/games/tidepool/prs/${prId}`)).data;
assert(prAfter.status === "merged" && prAfter.merge_sha, "PR recorded as merged with the commit sha");

console.log("== FINAL LEDGER CHECK: all three stores agree ==");
const finalList = (await api("GET", "/api/games")).data;
const ftp = finalList.find(g => g.slug === "tidepool");
const ffk = finalList.find(g => g.slug === "tidepool-bob");
assert(ftp.stars === 1 && !ftp.forked_from && ffk.forked_from === "tidepool" && ffk.owner_handle === "bob",
  "SQL: stars/ownership/lineage all correct");
const meA = (await api("GET", "/api/me", { token: A })).data;
const meB = (await api("GET", "/api/me", { token: B })).data;
assert(meA.games.includes("tidepool") && !meA.starred.length &&
       meB.games.includes("tidepool-bob") && meB.starred.includes("tidepool"),
  "per-user views coherent (alice owns, bob owns fork + starred original)");
const recheck = await api("GET", exp.data.urls[0]);
assert(recheck.status === 200, "alice's frozen export URL still serves after all subsequent commits");

console.log(`\nJOURNEY COMPLETE — ${step} assertions, 0 failures.`);
console.log("The system is confirmed: host → own → author → fork → isolate → propose → merge → agree.");
