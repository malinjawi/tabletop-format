# Languages — Census & Policy
*What's actually in this codebase, why, and the migration path now that serious
coding begins. Honest revision of the original "TypeScript everywhere" lock.*

## Census (what runs today)

| Language | Where | Lines-ish | Why it's there |
|---|---|---|---|
| **JavaScript** (Node ≥20 ESM, zero deps) | gateway, server, all platform/* stores, importers, semantic diff, git porcelain, LFS client, fmt CLI, editor/hub browser JS | ~3,500 | The platform. Zero-dep by necessity (sandbox) which became a virtue: instant boot, no supply chain |
| **Python 3** (stdlib + Pillow/PyYAML/jsonschema/ReportLab) | reference renderer, print/PnP/TTS exporters, validator twin, stats, credits, deck/jam/license checkers, site/editor/hub builders | ~2,500 | Born of sandbox constraints (no npm → no ajv/puppeteer), **kept on merit** — see policy §2 |
| **SQL** (SQLite/Postgres-compatible subset) | migrations/ | small | Store 2 canonical schema |
| **Bash** | e2e.sh, perf.sh, demo.sh, fork-demo.sh, build_beta.sh | ~700 | Test harnesses & assembly |
| **JSON Schema / YAML / Markdown** | the format itself | — | Deliberately language-NEUTRAL — that's the moat |

## Policy (what to use from here)

**1. JS → TypeScript, gradually, starting now.** The original lock stands for the
platform: TS is the destination. Path of least regret:
- Phase A (zero toolchain, active immediately): `// @ts-check` + JSDoc types on the
  shared contracts (`tools/lib/*`, `platform/*`) — editors type-check these today.
- Phase B (first day on a real machine): `npm i -D typescript` → `npm run typecheck`
  (tsconfig.json is committed, `allowJs+checkJs+strict`, noEmit) — type errors become
  CI failures with zero build-step changes.
- Phase C (with the Next.js frontend): rename to `.ts` module-by-module, starting with
  `lib/` (the contracts), generate types from the JSON Schemas
  (`json-schema-to-typescript`) so the format stays the single source of truth.

**2. Python is PROMOTED, not deprecated.** The plan said "Python at the edges";
reality earned it a permanent seat with a defined role: **reference implementation.**
The Python validator twin caught real spec bugs the Node one missed (and vice versa) —
two independent implementations are how open formats stay honest. Assignment:
- Canonical production renderer: HTML/CSS + Chromium in TS (decision R1, unchanged —
  built when the Next.js editor lands, pixel-parity with the browser).
- Python Pillow renderer/exporters: the *reference/fallback* — CI-light, zero-browser,
  and proof any language can implement the spec.

**3. What we do NOT add** (recorded so enthusiasm can't): Go/Rust (no measured need;
the heavy lifting is Forgejo's/R2's), heavyweight frameworks pre-scale (gateway kernel
→ Fastify is a planned 90-line swap, not an invitation), ORMs (the SQL subset IS the
portability layer), transpiled exotics. New-language proposals must name a workload
the current set measurably fails.

**4. Contributor guidance:** plugins may be `node` or `python` (plugins.json declares
the runner — already true). Keep zero/stdlib deps in tools; the format itself must
never require ANY language (JSON+YAML+images, SPEC.md is the contract).
