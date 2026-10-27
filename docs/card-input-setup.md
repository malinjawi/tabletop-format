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

## Add and place a field in the integrated workspace

Maintainers can now open **Design → Edit visually / Open Forge Studio → Add
field**. The card list, exact card preview, value input and placement controls
stay together. Name the field, enter a value for the selected card, then drag
the new element or use Left, Center, Right and Bottom. Arrow keys move it by
0.5 mm (Shift: 2 mm); Undo move and Cancel field are available before saving.

Number is the initial value type. Field options also offer Text and availability
on the selected card type or all card types. Show on card can be turned off for
editor-only metadata. No default is applied to other cards. Empty, zero and false
remain distinct. Choosing another card changes whose value is edited; it does
not create a different position for that card.

**Review field** stays next to the preview and lists changed values and files.
Save changes commits the definition, explicit card values and placement
atomically, then reopens the same family and card. The existing Table, artwork,
printings, Layout, Colors, proofs, exports, history and contributor review paths
remain available. Card setup is still the place for changing existing types,
required rules, choices, defaults, sections and archival.

New elements belong to the selected family source, with an explicit paint order.
Field availability and placement scope remain separate: making a field available
on all types does not place it on all templates. Use **Place on card** in another
family when needed. **Edit on card** focuses an existing connection. Some old
elements belong to shared components; the editor warns about that and the review
lists the templates affected by moving them.

### Save and compatibility contract

The exact Studio source response includes `setup` from the same commit as its
cards and SVG. The existing `/design/studio` candidate accepts an optional
`workspace: { family, setup, regions }` extension. It is maintainer-only,
additive, bounded, and requires an exact current `base_ref` and a `review_token`
for the final candidate bytes. Older Studio requests continue to use their
existing merge contract.

Existing field definitions cannot be removed or rewritten through this
extension. New region IDs cannot shadow existing regions, and placements must
bind to an active declared field and remain inside the card. Candidate files are
validated in a disposable materialization before writing. Stale references,
changed review candidates and unrelated uncommitted source changes are rejected.
Local stores additionally check the expected reference under the write lock.
Hosted stores retain their existing head recheck limitation; this does not claim
a new remote compare-and-swap guarantee.

Recovery drafts include setup and the in-progress field, scoped to account,
project, family and source version. Cancel removes that field's unsaved changes
without reverting unrelated card or artwork edits. Existing committed projects
need no migration: this uses the same attribute and layout format as before.

Verification: `npm run test:studio-fields` checks the real Studio API against an
isolated Netrunner fixture, including all-family layout preservation, zero values,
atomic save, permissions, review tampering, dirty/stale source protection,
reopening, legacy SVG round trips and metadata-only fields. The standing `e2e.sh`
suite includes this check.

Field review shows pre-existing text-fit or symbol issues separately when both the
affected content and layout are unchanged. They remain visible for Proof review
without blocking an unrelated new field. New issues, changed text, or changed
affected regions still block saving. Canonical candidate validation always runs.

Save completion is tied to the reviewed draft and route. Duplicate requests are
blocked while a save is in flight. If edits or navigation continue during the
request, completion preserves newer work and never reopens over another screen.
