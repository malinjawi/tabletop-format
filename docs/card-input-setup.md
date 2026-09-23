# Card input setup

Maintainers open **Cards → Card setup** to define their team's editing form. This changes the input contract; layout-family matching and printed field placement remain separate design concerns.

## Creator workflow

1. Define card types using the game's vocabulary. Types used by existing cards cannot be removed. A new type does not automatically create a printed layout family.
2. Add a field: display name, Text / Whole number / Decimal number / Dropdown / Yes–no, help text, section, scope, required flag, optional default, and numeric bounds.
3. Choose all types or specific types. The preview and both main card editing surfaces use the same visibility rules. Move fields with the up/down controls or drag them; sections follow their first field's position.
4. Try the form preview. Sample input is not card data. On narrow screens switch between **Edit setup** and **Preview form**.
5. Review. Forge names changed settings and every existing card that would receive a default. Defaults fill missing applicable attributes only, including explicit `false` and `0`; existing values are never overwritten. Existing incompatible values block saving, with the affected cards named.
6. Save the reviewed setup. Configuration and any default-filled cards enter one commit. Hidden fields keep their definitions, stored values, and template bindings. Restore a hidden field to use it again.

Existing field keys are permanent. Renaming a field in setup changes its display name without breaking templates, spreadsheet mappings or historical card data. New keys are generated from the display name; creators never have to type a data path.

Open Design, select a text layer or badge, and use **Show value from** to connect a field to print. Form sections do not rearrange the physical card. Studio carries field connections through the same reviewed SVG working-copy contract as layout edits. It accepts declared card fields and supported printing text fields, preserves older working copies, and rejects competing binding changes.

## Persistence and access

`GET /api/games/:slug/card-setup` returns an exact source revision, setup and cards only to authenticated writers. `POST` validates the candidate without writes. `POST ?commit=1` requires the same revision and the review token for that exact setup, validates the complete game, and rechecks the source before saving. Non-maintainers receive a refusal; setup does not silently fork someone else's game.

Local storage enforces the expected revision inside its mutation lock. Hosted storage currently has the same final source/head recheck as other editor routes; the Forgejo batch API does not supply a repository-head compare-and-swap. Do not claim that this closes all external-writer races on hosted deployments.

A tab keeps an account/project-scoped draft in session storage. A matching-version draft can be restored on reload. If the game advanced, the old draft is retained separately and can be downloaded; it is never silently applied to the newer source. A review invalidates on every setup edit. A stale save keeps the draft and requires reopening the current version. Draft recovery is not a backup and does not span browsers or closed tabs.

## Portable format and migration

The additive optional properties live in `game.yaml`:

- `card_types`: ordered, unique list of allowed card types. Legacy games without it infer available choices from existing cards and type colors. After setup saves it, validators require every card's type to be declared.
- Existing `attribute_definitions` retain `key`, `name`, `type`, `choices`, `required`, and `description`.
- `applies_to`: nonempty list of card types; omission means all. It controls visibility and required checks, not deletion. Values outside scope still retain type/choice/range validation.
- `section`: input-form group. Definition order determines field order within sections; sections appear in first-occurrence order.
- `default`: typed string, number or boolean. The reviewed setup migration can fill missing values; new-card controls use it. Validators never mutate data or synthesize values.
- `minimum`, `maximum`: inclusive numeric bounds, valid only for numeric fields.
- `archived`: hides the field and stops required checks. Existing values still validate and remain usable by printed layouts.

No format-version bump or automatic rewriting of old games is required. Existing definitions keep their prior semantics until edited. Both reference validators support the extension. Older Forge versions with closed schemas must be upgraded before opening a game that uses the new properties. Import/starter paths converge on the same definitions; a starter preserves a previously configured input contract.

## Verification

`npm run test:card-fields` checks non-destructive migration, incompatible changes, typed defaults, conditional required fields, starter preservation, and JavaScript/Python validator agreement. `npm run test:ui-card-setup` exercises the real browser and server against a disposable original game: preview, default impact review, reload recovery, hidden values, sections/order, mobile layout, actual editing surfaces, review binding, stale writes, and authorization. The functional and launch gates include these checks.
