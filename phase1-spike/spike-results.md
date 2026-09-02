# Spike results — 2026-07-28T16:04:37Z
Forgejo image: codeberg.org/forgejo/forgejo:11

- ✅ admin token minted
- ✅ A1: sudo-created repo owned by alice
- ✅ B1: 3 files → exactly 1 new commit (init+batch=2 total)
- ✅ C1: contents API honors .gitattributes on THIS Forgejo (bypass fixed upstream) — explicit LFS path kept as version-independent hardening
- ✅ C2: OUR lfs.mjs client uploads+downloads via real Forgejo LFS, bytes identical
- ✅ C3: pointer committed via API; git holds pointer (workaround VERIFIED end-to-end)
- ✅ D1: stale sha rejected (422) — conflict primitive works
- ✅ E1: cross-fork PR opened (#1)
- ✅ E2: alice merged bob's PR; authorship preserved in history
- ✅ F1: push webhook delivered (container sink on compose network)
- ✅ G1: forgejo dump produces archive (restore drill: manual, see checklist)

**11 passed, 0 failed** — 2026-07-28T16:04:53Z
