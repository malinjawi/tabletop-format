# SPEC — Git Data Model v1.0 (LOCKED)
*The normative specification for how a game lives in git (Forgejo + LFS → R2).
Format schemas: v0.1. Conformance test: `fmt validate` green = conforming repo.
Changes to LOCKED sections require a format_version bump and a shipped migration.*

---

## 1. Versioning policy

- Every `game.yaml` carries `format_version` (semver). Current: **0.1.0**.
- **Patch** = clarifications, no file changes. **Minor** = additive, old repos stay valid.
  **Major** = breaking, ships with `fmt migrate` — repos in the wild are never stranded.
- The JSON Schemas in `schemas/` are the machine-normative definition; this document
  is the human-normative one. Conflict = bug; schemas win until patched.

## 2. Repository model (Forgejo)

- **One game = one repository.** No monorepos of games; no game split across repos.
- Ownership: repo lives under the platform user's Forgejo account
  (`{user}/{game-slug}`), created/operated via admin API + `Sudo:` header.
- Slugs: kebab-case `[a-z0-9-]`, 2–64 chars, unique per owner, immutable after
  creation (renames = new repo + redirect, platform-level).
- Default branch: **`main`**. Bare repos initialized with `-b main` (never master).
- Branches: free-form for drafts; PRs come from forks or branches. No namespace rules
  imposed at v1 beyond git's own.
- Tags: releases only, format **`vX.Y.Z`**, always annotated (§8).
- Forks: server-side Forgejo forks. Platform commits an `attribution:` block into the
  fork's `game.yaml` immediately after forking (§9). Fork repos are full members of
  this spec (a fork is just a game).

## 3. Canonical tree (LOCKED)

```
game.yaml                    REQUIRED  manifest (schema: game)
components/cards.json        REQUIRED  card rules-identities [card]
components/printings.json    REQUIRED  physical appearances [printing]
components/tokens.json       optional  non-card components [token]
rules/rules.md               RECOMMENDED  rulebook, markdown only
design/brief.json            optional  versioned design intent + smallest playable slice
design/prototype.json        optional  runnable low-fidelity test plan [prototype]
design/notes.md              optional  designer diary
sets/*.yaml                  RECOMMENDED  sets/packs [set] (file may hold a list)
formats/*.yaml               optional  play formats [format]
restrictions/*.yaml          optional  dated banlists [restriction] — IMMUTABLE once
                                       referenced by a published format (new wave =
                                       new file; never edit history)
rulings/rulings.json         optional  dated clarifications [ruling]
decks/*.json                 optional  decks [deck]
setups/*.yaml                optional  playable table staging [setup] — seats, zones,
                                       deck stacks, starting placements, counters
playtests/*.json             optional  session logs [playtest] (version_ref → sha/tag)
community.yaml               optional  governance/contributors/roadmap [community]
CHANGELOG.md · CREDITS.md    optional  committed conveniences (regenerable by fmt)
assets/**                    optional  SOURCE art only — LFS-tracked (§6)
assets/manifest.json         optional  production source packages + editor/target contracts
templates/layout.yaml        optional  declarative Forge layout
templates/production.json    optional  shared SVG/native-editor field-binding contract
templates/source-overlay.yaml optional immutable-face patch map for narrow PnP proofs
templates/affinity/*.json    optional  native-editor transport adapter (may reference production.json)
translations/<locale>/**     RESERVED  (v0.2 target; NRDB sidecar pattern)
boards/*.json                RESERVED  (v0.2+: grids/zones/slots/tracks — FUTURE-GENRES.md)
scenarios/*.yaml             RESERVED  (v0.2+: authored missions/objectives/options)
tables/*.json                RESERVED  (v0.3: CRTs/reference charts — no open standard exists; ours would be first)
exports/                     FORBIDDEN in git — derived output, gitignored
```

Unknown extra files are permitted (git is git) but MUST NOT be required by tools —
anything the ecosystem depends on must enter this spec first.

## 4. Entity schemas (machine-normative, frozen at v0.1)

`game` (manifest incl. **attribute_definitions** — the per-game card schema —
symbols+glyphs, type_colors, default_provenance, attribution) · `card` (two-tier
rules identity) · `printing` (appearance; per-asset provenance) · `token` · `set` ·
`format` (card_pool + active_restriction_id) · `restriction` (dated, immutable) ·
`ruling` · `deck` · `design-brief` (intent + MVP) · `prototype` (materials + runnable first test) · `setup` (platform-neutral playable staging) · `playtest`
(version_ref pins feedback to a sha) · `community` ·
`jam` (jams live in the PLATFORM repo's `jams/`, not in game repos).

## 5. Identity & referential rules (LOCKED)

- IDs are **stable, opaque, never reused, never positional**.
  `card/printing/token` ids: snake_case `[a-z0-9_]{2,64}`. `game/set/format/
  restriction/deck/jam` ids: kebab or snake per schema. Renaming a card's *name*
  never changes its *id*.
- All cross-references point at ids (banlists → card ids; printings → card_id+set_id;
  decks → card ids; playtest notes → card ids; rulings → card ids). The validator
  enforces referential integrity; a dangling reference is a hard error.
- Deleting a card whose id is referenced anywhere is a validation error — deprecate
  by removing its printings instead (rules identity persists for history).

## 6. Content & encoding rules (LOCKED)

- **JSON** for record data: UTF-8, LF, 2-space indent, trailing newline. Tools
  preserve array order (order is meaningful for display; identity never is).
- **YAML** for human-edited config: plain subset; **dates always quoted strings**
  (`"2026-07-01"`) — unquoted YAML dates coerce to native types and break interchange.
- **Markdown** for all prose (rules, design notes). PDF/HTML are export targets, never sources.
- Card text symbols: `[key]` tags; every key must be declared in `game.yaml symbols`
  (validator-enforced). Errata = commits to `text`; clarifications = `rulings/`.

## 7. Binary & LFS policy (LOCKED)

- LFS pattern: `assets/**` only. Browser uploads accept raster/vector art,
  audio, fonts, and explicitly declared native production/model sources
  (`afdesign`, `afpub`, `idml`, `sla`, `kra`, `ora`, `xcf`, `blend`, glTF,
  OBJ, and STL). Opaque native sources are stored and reviewed as bytes; Forge
  never executes them or claims to merge their internal object graphs.
  Per-file soft cap 25 MB (platform-enforced), repo soft cap 2 GB at v1.
- **Only source assets.** Sprite sheets, PDFs, TTS saves, renders → `exports/`
  (gitignored) and the derived cache; committing them is a validation warning.
- Storage: LFS objects are content-addressed (sha256 OID) in R2, instance-global —
  forks share blobs at zero cost. R2 bucket: `lfs/{oid[0:2]}/{oid[2:4]}/{oid}`
  (Forgejo default layout).
- **API write path (the landmine rule):** platform writes NEVER push binaries through
  the contents API (bypasses LFS). Binaries go via the LFS batch protocol; the
  matching pointer file (`version/oid/size`, 3 lines) is committed in the same
  atomic batch commit as any JSON changes. CLI/git-push users get normal
  `.gitattributes` behavior.

## 8. Commit, history & release conventions (LOCKED)

- Platform writes = **one logical change, one commit**, via the batch contents
  endpoint; file-SHA optimistic concurrency per operation (stale = 422 = conflict
  dialog upstream; nothing half-written).
- Auto message format: title `cards: changed 2 cards (Ash Cloak, Bellows)`;
  body `* Card: field old -> new` lines. Human `-m` overrides title, never the body.
- Authorship: commits carry the acting platform user's identity (via per-user Forgejo
  account). Server-generated commits (e.g. attribution) use `platform <noreply@…>`.
- Validation gate: the platform never commits a tree that fails `fmt validate`
  (invalid = 422 + rollback). Direct git pushes are not blocked at v1 (portability
  first); CI surfaces validation state instead.
- Releases: annotated tag `vX.Y.Z`; message = generated card-changes since previous
  tag; `game.yaml version` SHOULD match; frozen PnP/TTS artifacts land in the
  derived cache keyed by the tag.

## 9. Fork & attribution (LOCKED)

On fork, the platform immediately commits to the fork:
```yaml
attribution:
  source_id: <origin game id>
  source_title: <origin title>
  source_url: <origin url>
  source_license: <origin license at fork time>
  source_ref: <exact source commit copied into this edition>
```
License compatibility is enforced at *publish* (check_licenses: NC propagates,
ShareAlike carries), not at fork (private experimentation is always allowed).

A fork is an independent edition, not an implicit pull request. Its owner may
make and release any number of changes permitted by the source license. Sending
changes upstream is a later, explicit action that selects the edition as a PR
source. The platform resolves `latest` to a commit before copying, so even a
fork made while the source is active records one reproducible starting point.

## 10. Conformance

A repo conforms to Git Data Model v1.0 iff `fmt validate` passes with 0 errors.
The e2e suite (69 checks) is the reference test of the model end-to-end: schemas,
integrity, imports, exports, porcelain, fork loop, server write path.

*Locked July 2026. Amendments append here with date + rationale + migration note.*

## Amendments

**2026-07 (v1.0 implementation-status audit).** Recorded honestly after fact-check:
§2 (Forgejo repo model, per-user accounts, slug redirects), §7's LFS/R2 storage +
size caps, and §8's file-SHA optimistic concurrency are **specified and researched
but NOT yet executed** — all are gated on the Phase-1 spike (`phase1-spike/`), whose
checklist exists precisely to verify them before platform code depends on them.
Everything else in this spec is enforced today by `fmt validate` + the e2e suite,
against plain git. Two reconciliations shipped with this amendment: (a) the
reference repo keeps its tiny placeholder assets (<100 KB total) as plain git blobs —
zero-dependency `git clone` (NF1) outranks LFS purity at this size; LFS activates at
platform hosting per §7; (b) `fmt fork` now auto-commits the §9 attribution block
when `game.yaml` is at repo root (the one-game-one-repo model), and validators warn
on dangling asset references.

### 2026-09-02 — Production source packages

Added `assets/manifest.json` (`forge-source-assets` v1) so a repository can name
the authoritative editable packages behind cards, books, boards, audio, fonts,
table setups, and optional 3D pieces. Each package pins its adapter direction,
source files, previews, release targets, distribution boundary, and deterministic
input hash. Native formats remain opaque versioned source; portable Forge/SVG/
HTML representations remain preferred when a real round trip is available.
The existing per-file rights manifest still decides whether bytes may ship.

### 2026-07-28 — §7 landmine is version-dependent (spike evidence)
The Phase-1 spike against Forgejo 11 observed the contents API **honoring**
`.gitattributes` (naive binary upload stored as an LFS pointer): the gitea
#18297 bypass is fixed on that version. Earlier verified behavior (LFS server
misconfigured/disabled, older Gitea/Forgejo) stores raw binary — the landmine.
No spec change: the platform's write path REMAINS explicit LFS batch upload +
pointer commit (§7), because it is correct on every version, keeps oid/dedup
under platform control, and allows pointer+JSON in one atomic commit. The
spike's C1 records observed behavior per target rather than gating on it.
