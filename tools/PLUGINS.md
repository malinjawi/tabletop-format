# Adding an import/export plugin

Import/export formats are plugins: a script + one entry in `tools/plugins.json`.
No core code changes. This is the most-wanted kind of contribution — Cockatrice,
MTGJSON, Scryfall, Screentop, OCTGN bridges all fit this shape.

## The contract

**Importers** produce (or add to) a valid game directory:
```
<your-script> <source> <out-dir> [options]
```
- Output must pass `fmt validate <out-dir>` — that's the whole contract.
- Generate stable IDs (snake_case from names; never positional).
- Unknown source fields → typed `attributes` (infer integer/number/boolean/string).
- Imported third-party content: set `license: imported-see-source` in game.yaml
  so the publishing gate forces a deliberate decision.

**Exporters** consume a game directory:
```
<your-script> <game-dir> [options]
```
- Read only via the documented files (game.yaml, components/, sets/, ...).
- Write into `<game-dir>/exports/` (gitignored — exports are derived).

## Registering

Add one entry to `tools/plugins.json`:
```json
"cockatrice": { "runner": "node", "script": "import-cockatrice.mjs",
                "usage": "<cards.xml> <out-dir>", "desc": "Cockatrice card XML" }
```
`runner` is `node` or `python` (keep deps zero/stdlib if possible — see existing
plugins). `fmt import cockatrice ...` and the help text now just work.

## Testing (required for PRs)

1. Add a small real-data fixture under `examples/` (like `nrdb-fixture/`).
2. Add a round-trip check to `e2e.sh`: import fixture → `validate` passes.
3. `./e2e.sh` fully green.

## Reference implementations

- `import-csv.mjs` — zero-dep parsing, attribute inference, scaffolding
- `import-nrdb.mjs` — two-tier dedupe (printings→cards), HTML stripping, symbol mapping
- `export_tts.py` — sheet math, external-format constraints (4096px, 10x7)
- `export_vtt.py` — versioned setup → native VirtualTabletop state + embedded-asset `.vtt`
