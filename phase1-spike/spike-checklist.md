# Phase 1 Integration Spike — Checklist
*Goal: prove every Forgejo integration assumption with curl before writing platform code. Budget: 1–2 days. Every item maps to a resolved decision (R2–R5) in `execution-architecture-roadmap.md`. If any item fails on current Forgejo, we want to know NOW.*

Setup: `docker compose up -d`, create admin: `docker exec -u 1000 spike-forgejo forgejo admin user create --admin --username root --password <pw> --email you@example.com`, then make an admin token in the UI (scopes: all). `export T="Authorization: token <TOKEN>" H=http://localhost:3000/api/v1`.

## A. Multi-tenancy (R2) — user-per-platform-user via sudo
- [ ] `curl -H"$T" -XPOST $H/admin/users -d '{"username":"alice","email":"a@x.co","password":"...","must_change_password":false}'` → 201
- [ ] Create repo AS alice via sudo: `curl -H"$T" -H"Sudo: alice" -XPOST $H/user/repos -d '{"name":"ember","auto_init":true}'` → repo owned by alice
- [ ] Commit authorship: file created via sudo shows author alice, not root

## B. Atomic batch commits (R5)
- [ ] `POST $H/repos/alice/ember/contents` with 3 files in one `files:[]` payload → ONE commit containing all three
- [ ] Response includes per-file sha + single commit sha

## C. THE LANDMINE — LFS via API (R3)
- [ ] Push `.gitattributes` (`assets/** filter=lfs ...`) via API, then create a PNG via contents API → **confirm it lands as a git blob, NOT LFS** (this is the expected bad behavior we designed around — verify it's still true on current Forgejo)
- [ ] Workaround path: LFS batch API (`POST /alice/ember.git/info/lfs/objects/batch`, `operation:"upload"`) → upload blob → commit hand-built pointer file via contents API → `git clone` + `git lfs pull` as alice → **asset bytes come back intact**
- [ ] With R2 config on: blob physically lands in the R2 bucket (check Cloudflare dash)
- [ ] Fork alice/ember as bob (sudo) → bob's clone resolves the same LFS object (shared storage, no duplication)
- [ ] Raw/media endpoint: does `GET /repos/alice/ember/media/<path>` return the FILE (not the pointer)? Record which endpoint resolves LFS.

## D. Optimistic concurrency (R4)
- [ ] `PUT .../contents/<file>` with stale `sha` → **422** (this error is our conflict-detection primitive)
- [ ] Same behavior inside batch endpoint per-operation

## E. Fork & PR flow (D7)
- [ ] `POST /repos/alice/ember/forks` as bob → fork appears under bob
- [ ] Bob edits a card via API, opens PR against alice/ember via API → alice can merge via API
- [ ] Merged commit preserves bob's authorship (attribution chain)

## F. Webhooks (D3 sync)
- [ ] Register webhook (push+fork+pull_request) → receive events with `X-Forgejo-Event` header + valid HMAC signature on a test listener (e.g. `npx serve`-style echo or webhook.site)

## G. Ops sanity
- [ ] `docker exec spike-forgejo forgejo dump` produces archive; restore into a fresh container; alice's repo + LFS intact (use pg_dump for DB — Forgejo's SQL dump is known-buggy)
- [ ] Note versions: Forgejo image tag + API responses saved to `spike-results.md` for the record

## Exit
Write `spike-results.md`: item → pass/fail → evidence (curl output). Any FAIL on C's workaround path = stop and re-plan storage (fallback: assets.json manifest + direct R2, per architecture doc §escape hatch). All pass = green light for Blocks G/H code.
