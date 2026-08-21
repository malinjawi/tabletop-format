# Honest Audit — tabletop-format platform

Conducted by exercising a real, booted instance of `server.mjs` over HTTP (scratch copy,
`git init` + one commit, `DB_PATH`/`CACHE_DIR` pointed at a scratch dir, `node server.mjs
--port 47231`), plus direct inspection of the served hub HTML/JS and the route source. No
claim below is a guess — every number, status code, and behavior was produced by an actual
request/response or a grep against the exact file cited. Server was killed at the end of
the run; no state from this audit persists outside this document.

---

## VERDICT

No — a stranger cannot use this product today for either of its two stated audiences.
A player can browse, register, and successfully open a pull request against any of the 12
shipped games — but that pull request can never be merged by anyone, ever, because none of
the 12 games have an owner and the merge/release routes have no path for an unowned game
(verified live: two different accounts both got `403 "only the game's owner can merge"` on
the same PR). A designer cannot create a game at all through the UI: the only "create"
entry point, the **"+ New game"** button, is a hard-coded `alert()` box that has never been
wired to the real, working creation API sitting one line of JavaScript away from it. What
exists is not a demo and not quite a prototype either — it is a genuinely sophisticated,
well-tested **backend** (git-native versioning, a full PR/review/merge system, three working
export formats, a 159/160-passing internal test suite) wearing an unfinished, in places
actively fake, **frontend**. The gap between the two is the whole story: this is much closer
to "ship the missing UI and fix one authorization bug" than "the product doesn't work."

---

## REPORT CARD

| Area | Grade | Evidence |
|---|---|---|
| First impression / onboarding | **D** | `GET /` returns one inline `<script>` of **29,530,495 bytes** (4.9s to build/serve locally); the top bar itself labels the product "prototype" (`tools/hub_template.html:178`); the one obvious growth CTA, **"+ New game,"** is `onclick="alert(...)"`. |
| Player contribution flow | **C-** | Browse → register → propose all work and produce a real PR with a correct diff (verified live) — but the exact action every visitor is funneled toward dead-ends: the resulting PR can never be merged on any of the 12 shipped games (see Blocker #2). |
| Designer game-creation flow | **F** | Zero UI path exists. `onclick="alert('Platform: creates a repo + format scaffold. CLI today: fmt import csv...')"` (`tools/hub_template.html:182`), unconditional, no `LIVE` gate; a full-file search of every `fetch(...,{method:"POST"...})` call site in the 3,756-line template shows **no** call to `POST /api/games` anywhere. |
| Card editing | **B-** | The live in-hub editor genuinely works: validated commit, specific validation-error surfacing, correct fork-to-PR fallback when the user lacks write access (all verified via live `PUT`/`POST .../cards/propose` calls). Docked for a native `prompt()` (line 3033) and `confirm()` (line 2981) inside an otherwise custom-modal app, and a fully dead second editor (`openEditor_UNUSED()`, line 2834) plus its orphaned `<canvas id="ed-canvas">` (line 209) still shipping on every page. |
| Card design (layout editor) | **C+** | `PUT /api/games/:slug/layout` verified live — committed a real `templates/layout.yaml` from a JSON payload, server-side shape validation confirmed. Not visually exercised (no browser available in this environment); the code's own comments flag a hand-synced duplicate YAML serializer (browser JS vs. server JS, `server.mjs:433`) as a standing drift risk the authors themselves called out. |
| Rules authoring | **C** | `PUT .../artifact` verified live with correct idempotent no-op detection and an allowlist that correctly `422`s disallowed paths — but 2 of the 12 shipped games ship one-line placeholder rules (`examples/harbor-nine/rules/rules.md`: *"Rules go here — this file diffs like code."*). |
| Collaboration (PR / fork / merge) | **D+** | The full fork → propose → review → comment → merge → notify cycle works **flawlessly** on an owned game (verified live end-to-end, merge commit correctly authored as the proposer) — but is structurally impossible on any of the 12 flagship games (see Blocker #2). |
| Jams | **B** | `GET/POST /api/jams/...` all verified live: joining forks a real starter into a real owned game, submitting runs a real qualification check, a non-running jam correctly `409`s. Docked only because it's currently the **one reliable no-API-knowledge path** to creating a game, and just 1 of 2 listed jams is open. |
| Play | **C** (partial) | Playtest logging verified live end-to-end (`POST .../playtests` → real version-pinned commit). The in-browser draft/play tab itself was not exercised in this audit (no browser tool available) — grade reflects incomplete testing, not a confirmed defect. |
| Export / print | **C+** | All three formats (`pnp`/`tts`/`ttc`) verified live and produced a genuinely valid, openable output (`file` confirms "PDF document, version 1.4, 2 pages"). But that 2-page, 5-card PDF was **34,096,019 bytes** — consistent with the 29.5MB homepage, this points to a systemic output-size problem. |
| Data integrity / versioning | **B+** | Every mutation is a real, validated git commit with an auto-written semantic message (verified across a dozen live writes in this audit); all 12 shipped games pass `tools/validate.py` with 0 errors. Docked for a live-confirmed catalog data bug (Blocker #10) and for the ownership gap undermining "every change is reviewable" for the entire flagship catalog. |
| Polish / consistency | **D+** | A real `toast()`/`prNote()` feedback system is used 83+ times — but 3 native `prompt()`/`confirm()` dialogs remain at the highest-stakes moments; a second, entirely dead "static demo" PR/release UI (`suggestions()`/`releases()`, lines 3391/3418) with its own fake `alert()` buttons sits next to the real, working one; sign-in gating is inconsistent (some actions auto-open the login modal, others just `toast("Sign in...")` and leave the user to find it themselves). |
| Mobile | **D+** | Only **8** `@media` rules in the entire served page — they collapse the app's 2-3 major split-panel layouts and adjust rulebook print typography; nothing found covering touch targets, navigation, or the card-grid/PR-diff views. Not independently verified at a real narrow viewport (no browser tool in this environment). |
| Error / empty / loading states | **C-** | Empty PRs/issues/releases on real games return clean `[]` with friendly copy (verified live on `hearts`, `decktet`). But only **2 of ~49** client `fetch()` call sites show any loading indicator, **7** use a bare `catch{ return; }` that fails completely silently, and a malformed JSON body returns a raw `500` with a leaked V8 parser string instead of a clean `400` (verified live). |
| Documentation | **C** | README/SPEC/CONTRIBUTING are unusually rigorous for an engineering audience, and the `WHAT-BROKE.md` files are an exceptional level of honest self-critique. But there is **zero** end-user documentation of how to create a game as a normal person — the one README line about it describes the old filesystem workflow, not today's hosted product. |

---

## TOP 10 BLOCKERS (ranked)

### 1. There is no way to create a game through the UI
**File:** `tools/hub_template.html:182`. **What a user experiences:** clicking **"+ New
game"** — the single most important call-to-action for the "designer" audience — pops a
browser `alert()`:
> *"Platform: creates a repo + format scaffold. CLI today: `fmt import csv your.csv
> my-game`"*

That is the entire feature. It is not gated by the page's own `LIVE` flag (every other fake
button in the file is — see Blocker #5), so this fires identically whether the server is
running or not. Worse, the CLI command it suggests doesn't even do what it implies: `fmt
import csv` (`tools/import-csv.mjs`) writes files to a local folder — it never talks to the
server, never creates an owner, never produces a URL. A search of every `fetch(...,
{method:"POST"...})` call in the 3,756-line template (`grep -n 'method:\s*"POST"'`) turns up
fork, sync, export, asset-upload, propose, issues, PR review/merge/close, releases,
playtests, and jam join/submit — **every** write route except `POST /api/games`, the one
that actually creates a game. The backend route itself works correctly (see "What's
genuinely good" below); nobody wired a button to it.

### 2. Pull requests and releases can never land on any of the 12 shipped games
**File:** `server.mjs` — merge route (`only the game's owner can merge`) and release route
(`only the game's owner can cut a release`). **What a user experiences:** a player opens a
PR (it works — real diff, real fork, appears correctly on the PR tab). Reviewing it, leaving
comments, all work. Clicking **Merge** always fails. Live proof from this audit:
```
POST /api/games/hearts/prs/pr_01b0549db9af83ef/merge   (as the PR's own author) → 403
{"error": "only the game's owner can merge"}
POST /api/games/hearts/prs/pr_01b0549db9af83ef/merge   (as an uninvolved 2nd account) → 403
{"error": "only the game's owner can merge"}
POST /api/games/hearts/releases {"tag":"v1.0"}          (either account) → 403
{"error": "only the game's owner can cut a release"}
```
Root cause: `GET /api/games/hearts/access` returns `"ownerless": true` for every one of the
12 shipped games (`reindexGames()` never assigns an `owner_id`), and `canWrite()`
(`server.mjs:105`) explicitly treats `ownerless` as "any signed-in user may write" — but the
merge and release routes use a **different, stricter check** (`game?.owner_id !== u.id`,
which is `true` — i.e., denied — even when `owner_id` is `null`) that has no equivalent
carve-out. There is also no route to *claim* ownership of an existing unowned game. The
result: the flagship "propose a change" journey — the thing the whole PR/fork system exists
for — cannot be completed by anyone, ever, on any of the games a new visitor is actually
shown.

### 3. Direct, unreviewed writes to the flagship games are wide open — while the "safe" path is closed
**What a user experiences:** because `canWrite()` allows any signed-in stranger to write
directly to an unowned game, a single `PUT /api/games/hearts/cards` from a brand-new account
landed immediately, no fork, no PR, no review, no confirmation:
```
PUT /api/games/hearts/cards  (as freshly-registered "player-a") → 200
{"saved": true, "commit": "c14ca32", "message": "cards: changed 1 card (2 of Clubs)"}
```
Combined with Blocker #2, the trust model is inverted: the reviewed, collaborative path
(fork → PR → merge) is the one that's permanently broken; the unreviewed, immediate-write
path is the one that's wide open on every showcase game.

### 4. Output sizes are large enough to be a real scale problem, not a cosmetic one
**What a user experiences:** loading the homepage downloads a **29,530,495-byte** (29.5MB)
page that is a single inline `<script>` containing base64 card art for the whole catalog,
regardless of which game (if any) the visitor cares about (`time_total: 4.885482`s to
generate/serve on localhost with zero network latency — this is a floor, not a ceiling, for
a real user's load time). Exporting a 5-card test game to print-and-play produced a
**34,096,019-byte**, 2-page PDF (confirmed a valid PDF via `file`, not a broken export — just
enormous for its content). This isn't a one-off: the same page-weight pattern shows up in
both the homepage and the export pipeline.

### 5. Dead and duplicated UI code ships in the one file every page loads
**File:** `tools/hub_template.html`. Three separate, confirmed-dead code paths sit alongside
their real replacements in the same file that's served to every visitor:
- `openEditor_UNUSED(slug, cid)` (line 2834) — a second, complete card-editor implementation
  (with its own `alert()` at line 2836) that references a `<canvas id="ed-canvas"
  width="600" height="840">` (line 209) which no live code anywhere draws into or even reads
  (`grep -n "ed-canvas\|getContext"` finds only the markup itself). The real editor
  (`openEditor()`, line 2827) was rewritten to route through the SPA instead and explicitly
  comments *"Do NOT early-return on !LIVE here — that used to kill editing in the static
  showcase build entirely,"* confirming this was a live, shipped bug that was patched by
  routing around the old function rather than removing it.
- `suggestions(g)` (line 3391) and `releases(g)` (line 3418) — a whole parallel "static
  demo" PR/release renderer whose buttons are unconditional `alert()` placeholders
  (*"Platform: 3-way merge on card JSON... Today: `git merge`..."*, *"Platform: frozen PnP
  PDF + TTS mod..."*). Confirmed dead when the server is live (`if(LIVE) return
  liveSuggestions(g)` / `if(LIVE) liveReleases(g)` both short-circuit to the real, working
  functions) — but it's real shipped weight and a landmine for the next person who edits this
  file without knowing which of the two near-identical functions is load-bearing.

None of this is user-visible today (confirmed: `LIVE` is true against a running server, so
the real functions win), but it means roughly 5% of this single template file is dead code
the team already knows is dead — one function is even self-labeled `_UNUSED`.

### 6. Two of the "12 games" have no actual rules
**Files:** `examples/harbor-nine/rules/rules.md` (12 words total: *"Rules go here — this file
diffs like code."*), `examples/netrunner-urbp/rules/rules.md` (15 words: *"Rules text lives
with the source community."*). Both games validate cleanly and both have real card data (7
cards each) — but a stranger who clicks into either from the catalog cannot learn how to
play. They are format-conformance fixtures wearing a game-catalog listing.

### 7. Native browser dialogs remain at the highest-stakes moments
**What a user experiences:** an otherwise fully custom-styled product (its own modal system,
its own toast notifications) drops back to unstyled OS-native dialogs for three real,
reachable actions: choosing an export format (`prompt("Export ... Enter 1, 2, or 3:")`,
line 2778), titling a pull request (`prompt("Title for your pull request:", s.title)`, line
3033), and confirming card deletion (`confirm('Remove "..." from this edit?')`, line 2981).
These are not fake — they're wired to real API calls — but they're jarring, easy to
dismiss by accident, and don't match anything else in the product.

### 8. Most background data loads fail completely silently
**What a user experiences:** switching to a tab whose data fails to load (server hiccup,
network blip, 500) shows **nothing** — no error, no retry, just whatever was already in the
pane. Confirmed by source: `tools/hub_template.html:2619, 2708, 3132, 3166, 3428, 3679, 3735`
all share the identical pattern `try{ x = await (await fetch(...)).json(); }catch{ return;
}` — covering the activity feed, sync status, analytics, balance diff, releases, jam detail,
and collaborators panels. Across the whole file, only **2** of ~49 `fetch()` call sites show
any loading indicator at all (`"Loading pull requests…"`, `"Loading issues…"`).

### 9. Malformed input returns a raw 500 with leaked internals instead of a clean 400
**Live proof:**
```
PUT /api/games/<slug>/cards   body: '{not valid json'
→ 500 {"error": "Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
```
The gateway's global `try/catch` (`platform/gateway.mjs`) prevents this from crashing the
server (confirmed — every subsequent request in this audit succeeded normally), which is the
right architecture. But a client mistake is being reported as a server fault (wrong status
code) and the client is shown a raw JS engine error string instead of a clean message.

### 10. A public-facing data bug, and a broken promise about the project's own test gate
**Live proof:** `GET /api/games` shows Mindbug's license as `"license": "\"Unconfirmed"` — a
mangled fragment of the real value, `license: "Unconfirmed — verify before hosting"` in
`examples/_fixtures/mindbug/game.yaml`. Root cause: `platform/store1-local.mjs:95` scrapes
`game.yaml` with a regex, `(gy.match(/^license:\s*(\S+)/m) ?? [])[1]`, that grabs only the
first non-whitespace token instead of parsing YAML — it silently truncates any quoted,
multi-word license string. Separately: `CONTRIBUTING.md:18` states *"`e2e.sh` is the
law"* and demands it stay green — this audit ran it and got **159/160 passing**, with the one
failure a hardcoded assertion from when the catalog had 3 games (`e2e.sh:285`, `"server
discovers 3 games"`, now legitimately 12). The failure itself is trivial, but a
"mandatory, must-stay-green" suite that's been red on a stale assertion is a process signal:
nobody ran the full suite as a gate through the recent run of game-porting work.

---

## WHAT IS GENUINELY GOOD

- **Git-backed versioning is real and correct.** Every write in this audit — card edits,
  layout changes, rules edits, playtests, merges — landed as an actual git commit with a
  correctly auto-generated semantic message (e.g. `"cards: changed 1 card (2 of Clubs)"`,
  `"merge: Rebalance Fireball to 5 mana (PR from ember-duel-test-game-player-a)"`). Nothing
  about this was staged or faked for this audit; it's the platform's default behavior.
- **The full collaboration loop works, completely, when a game has an owner.** Live,
  end-to-end, in this audit: fork → propose (auto-fork + PR) → review (approve, with correct
  self-review and non-maintainer blocking) → comment → merge (correctly authored as the
  *proposer*, not the merger — "credit follows the work") → notifications delivered to the
  right people. This is not a stub; it's a complete, well-designed feature.
- **The game-creation API itself is solid** — `POST /api/games` correctly requires a title
  (`422` if missing), falls back to a sensible default CSV, imports a realistic multi-column
  CSV correctly, assigns real ownership, and rejects slug collisions (`409`). The failure is
  100% that nothing in the UI calls it, not that it doesn't work.
- **Exports are real, not stubs.** All three formats (PnP PDF, TTS mod, Tabletop Club pack)
  were generated live in this audit and produce genuinely valid, openable output — the PDF
  was independently confirmed as a real 2-page PDF v1.4 document, not an empty or corrupt
  file.
- **All 12 shipped games pass the format validator cleanly** — 0 errors, 0 warnings, across
  card counts from 7 to 118. The underlying data model is sound.
- **Jams are a real, working, if narrow, on-ramp.** Joining forks a genuine starter game into
  the user's own account with an owner already set (meaning — unlike every other game on the
  platform — PRs *can* eventually be merged on it); submission runs an actual
  constraint-qualification check.
- **The `WHAT-BROKE.md` files are an unusually honest body of self-critique** — multiple
  multi-thousand-word documents cataloguing exactly where the schema fails to represent real
  games (Duelyst's board, Hearthstone's class restrictions, Netrunner's influence limits),
  written by whoever ported the fixture, before this audit ever started. That level of
  self-scrutiny baked into the repo is rare and valuable.
- **The server itself is resilient.** The gateway's global error boundary means a bad request
  (malformed JSON, a bad slug, an unauthenticated write) never took down the process — every
  one of the ~90 requests fired in this audit got a clean HTTP response, including the
  deliberately malformed ones.
- **The project's own 160-check end-to-end suite passes 159/160** (`./e2e.sh`, run live for
  this audit), covering schema validation, CSV/NRDB import, the live editor, auth, forking,
  PRs, access control, and issues — the one failure is a stale test expectation, not a
  functional defect.

---

## THE HONEST BOTTOM LINE

**"A player edits a card and proposes a change," made flawless:** the mechanics already
work end-to-end — this is a fix-and-polish job, not a rebuild. Concretely: (1) resolve the
ownerless-game authorization gap, either by assigning a real owner account to all 12 shipped
games or by adding the same "ownerless → any signed-in user" carve-out `canWrite()` already
has to the merge and release routes, then re-verify merge/release across all 12 — this is a
small, surgical server-side change but needs a real product decision about who "owns" the
showcase catalog and whether direct-write-by-strangers should keep working once merge does
(1-3 days). (2) Replace the 3 remaining native `prompt()`/`confirm()` calls with the
already-built custom modal (`askForm`) used everywhere else (half a day). (3) Give the 7
silently-failing fetch sites a visible error state (half a day to a day). (4) Decide, and
enforce, whether unreviewed direct writes to demo games should be allowed at all (half a
day). (5) Write real rules for harbor-nine and netrunner-urbp, or drop them from the "12
games" count (content work, not engineering). **Total: roughly 3-6 focused engineering
days.**

**"A designer creates a game from scratch," made flawless:** this needs one genuinely new
frontend feature, not new backend capability — every piece downstream of "create" (the card
editor, the layout designer, the rules editor, export, release) was independently verified
working in this audit against a game created purely through the API. The net-new work is: a
creation form (title + a CSV paste/upload, or a "start empty and add your first card"
path into the existing live editor) that calls the already-correct `POST /api/games`; wiring
it to the header button that currently just shows an `alert()`; and then walking the full
path — create → add/import cards → design layout → write rules → export → release — through
the actual UI the way this audit walked it through curl, to catch whatever empty-state or
routing gaps only show up in the browser. **Total: roughly 1-2 focused engineering weeks** —
mostly one well-scoped frontend feature plus integration testing across a backend path that
is already proven solid.

The pattern across both estimates is the same, and it's the headline finding of this audit:
**the hard, risky engineering here — git-native versioning, semantic diffing, three-way
merge, a real validation-gated write path — is already built and already works.** What's
missing is the last mile of connecting it to a human being who isn't reading the source
code.

---

## Post-fix status (2026-08-21)

A follow-up engineering pass closed the three ranked blockers above (#1, #2, #3) plus the
native-dialog part of #7 and the four fake `alert()` buttons called out under #5's "dead
and duplicated UI code." Nothing else in this document was touched — the remaining
blockers (#4 page weight, #5's `openEditor_UNUSED`/`ed-canvas` dead code, #6 missing rules
text, #8 silent fetch failures, #9 raw 500 on bad JSON, #10 the Mindbug license regex bug)
are **still open** exactly as described above. This section records what changed and the
live evidence for it; it does not re-run or re-grade the rest of the audit.

### Blocker #1 — no way to create a game through the UI: CLOSED

`tools/hub_template.html`'s **"+ New game"** button (top bar) and a new CTA on the
Explore page both now call `newGameModal()` — a real, custom-styled modal (title field;
a CSV textarea with a header hint derived from `tools/import-csv.mjs`'s `CORE` columns, a
"load example" link, and a file-upload button that reads a `.csv` into the same textarea;
three hardcoded starter-deck presets — 5/12/20 cards; and Google-Sheet-URL detection —
pasting a published sheet link into the cards box instead of CSV creates the game with the
server's default single-card CSV, then calls `PUT .../sync/sheet` → `POST .../sync/pull`
so the sheet becomes the source). Submit calls `POST /api/games {title, csv}` with auth
headers; 201 routes to `#/g/<slug>`; 409/422 show the error inline without closing the
modal; signing out first opens the existing auth modal and resumes into the new-game modal
on success (`_afterAuth`).

**Live evidence** (scratch server, fresh account): `POST /api/games
{"title":"UI Test Game","csv":"name,type,text,cost\nSpark,unit,Deal 1.,1"}` → `201
{"slug":"ui-test-game","owner":"playera","commit":"14b3709","cards":1,...}`; a follow-up
`GET /api/games/ui-test-game/cards` → `200 [{"id":"spark","name":"Spark",...}]`. All three
starter-deck presets were also POSTed for real and came back `201` with the exact expected
card counts (5, 12, 20).

### Blocker #2 — PRs/releases could never land on any of the 12 shipped games: CLOSED

Added `canAdmin(u, slug, { releases })` next to `canWrite()` in `server.mjs`: no user →
false; `owner_id == null` (ownerless/demo game) → true; `owner_id === u.id` → true;
otherwise, an invited collaborator → true **unless** `releases: true`, in which case only
the owner or an ownerless game qualifies (a collaborator may merge/close PRs and issues,
but may not cut a release — see the comment above `canAdmin`). Replaced the strict
`game?.owner_id !== u.id` checks with `canAdmin()` on: PR merge, PR close, issue close, and
releases. Anonymous callers still get `401` (unchanged — `requireAuth`/`canWrite`'s
own-null check runs first).

**Live evidence** (scratch server): user B, a fresh account with no relationship to
`hearts` (ownerless, like all 12 shipped games), forked it, edited a card in the fork,
opened a PR back to `hearts`, then **merged that PR as a non-owner** →
`200 {"merged":true,"commit":"0f3b185",...}` (this exact call returned `403 "only the
game's owner can merge"` before the fix — see Blocker #2 above). The edited card's new
text was confirmed present in `hearts`'s live card data afterward. B then **cut a release**
on `hearts` → `201 {"tag":"v1.0.0-livetest...","sha":"0f3b185",...}` (was `403`). B also
closed a second PR and an issue on `hearts` as a non-owner/non-author → both `200` (same
`canAdmin` sweep). A regression check confirmed the sandbox carve-out did **not** leak into
owned games: a collaborator added to a *real, owned* game (not ownerless) was correctly
refused when cutting a release on it → `403`; `journey.sh`'s own assertions #33 ("bob
CANNOT merge into alice's game — owner-only rule") and #60 ("only the owner can cut a
release") still pass unchanged.

### Blocker #3 — trust model backwards/invisible on ownerless games: ADDRESSED (visibility, not permission)

Per instructions, the permission itself was left alone (ownerless games are still an
intentional open sandbox). `GET /api/games/:slug/access` now returns a `sandbox` boolean
(`true` when `owner_id` is null) alongside the existing `ownerless` field. The hub now
fetches this on every game page and shows a badge in the header — "Open sandbox — anyone
signed in can edit directly" (tooltip: "fork it if you want your own copy") — and the card
editor's commit bar reads "Commits directly to this open game" instead of the generic
"lands as a commit" when `sandbox` is true.

**Live evidence:** `GET /api/games/hearts/access` → `{"authed":true,"canWrite":true,
"isOwner":false,"ownerless":true,"sandbox":true}`; `GET /api/games/ui-test-game/access`
(user A's own freshly-created game) → `{"authed":true,"canWrite":true,"isOwner":true,
"ownerless":false,"sandbox":false}`.

### Polish — placeholder alert/prompt/confirm: CLOSED

- The **"+ New game"** `alert()` is now `newGameModal()` (Blocker #1).
- `suggestions()`'s "Accept changes" `alert()` (3-way-merge explainer) was deleted outright
  — there is no live-independent equivalent to wire it to — and replaced with a plain note
  that merging needs the live platform; its "💬 Discuss" `alert()` now routes to the
  Issues tab (`go('g/<slug>/issues')`) as instructed.
- `releases()`'s two download `alert()`s were deleted; `liveReleases()` (the real,
  already-working frozen-download renderer) now takes over via `if(LIVE) return
  liveReleases(g)`, matching the same pattern `suggestions()`/`issues()` already used.
- `exportMenu()`'s `prompt()` (format picker) is now `exportModal()`, a styled 3-button
  chooser.
- `edCommit()`'s `prompt()` (PR title) is now `askForm()` — the same custom-modal helper
  already used elsewhere in this file (e.g. `proposePr()`).
- `edDelete()`'s `confirm()` (delete card) is now `confirmModal()`, a new small
  Cancel/Remove modal styled like `askForm()`; the function is now `async`.

**Verification:** `grep -c 'onclick="alert(' tools/hub_template.html` → `0`. `grep -n
'prompt('` / `'confirm('` → each has exactly one remaining match, and both are inside
code comments (one pre-existing, one newly added to document the replacement) — zero
matches inside actual executable code.

### Build / syntax / suite verification

- `node --check server.mjs` → OK.
- 12-game showcase rebuilt from `examples/{ember,harbor-nine,netrunner-urbp,arcmage,
  secret-hitler,decktet}` + `examples/_fixtures/{netrunner-sg,hearthstone-classic,hearts,
  cards-against-humanity,mindbug,duelyst}` via `python3 tools/build_hub.py --games
  /tmp/showcase -o /tmp/sc.html` → succeeded (29.2MB, unchanged order of magnitude — see
  open Blocker #4). The single embedded `<script>` extracted from that real, fully-baked
  build → `node --check` → OK.
- `node tools/store2-conformance.mjs` → **36/36 green**.
- `bash journey.sh` → **71/71 assertions, 0 failures**, in 7.4s (well under the ~100s
  budget).
- Full live-HTTP test against a fresh scratch copy (`git init` + one commit, its own
  `DB_PATH`/`CACHE_DIR`, `node server.mjs --port <random 47xxx>`): **25/25** checks passed,
  covering all five required scenarios (a–e) above plus six additional regression checks
  (PR/issue close by a non-owner on an ownerless game, collaborator-cannot-release on an
  owned game, and all three starter-deck CSV presets importing cleanly).

### Known gaps / honesty

- The new client-side code (`newGameModal`, `confirmModal`, `exportModal`,
  `loadSandboxBadge`, and the edited `edBar`/`edCommit`/`edDelete`/`authSubmit`) was
  verified by `node --check` (twice — stubbed `DATA` and the real 12-game showcase build),
  a full manual line-by-line re-read, and a static cross-reference of every new identifier
  against its definition — but **not** by actually running it in a browser. No browser
  tool, jsdom, or npm registry access (`npm install jsdom` → `403 Forbidden`) is available
  in this environment — the same limitation the original audit itself notes for its own
  mobile/viewport/in-browser-editor grades. This should be clicked through in a real
  browser before being fully trusted.
- The Google-Sheet-URL creation path (option (d)) calls the same `sync/sheet` +
  `sync/pull` routes the existing "connect a spreadsheet" feature already uses live, but
  was **not** exercised end-to-end against a real published Google Sheet in this pass — the
  sandbox's outbound network access is proxied/restricted and wasn't tested against
  `docs.google.com`. The two routes it calls are unchanged and were already covered by
  prior work.
- `canAdmin()`'s sweep intentionally did **not** touch the owner-only collaborator
  grant/revoke routes (`PUT`/`DELETE /api/games/:slug/collaborators/:handle`) — on an
  ownerless game `canWrite()` already grants everyone direct-write access regardless of the
  collaborator list, so that list is inert there, and widening who can grant/revoke it
  wasn't part of the instructed scope.
