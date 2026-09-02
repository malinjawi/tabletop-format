#!/usr/bin/env node
import assert from "node:assert/strict";
import { prepareCsvImport, publicCsvPreview } from "./lib/csv-mapping.mjs";

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; console.log(`  ✓ ${message}`); };

const source = `Card Key,Card Title,Category,Rules,Energy,Illustrator,Unused note
spark-01,Spark,unit,Deal 1 damage.,1,Ada,working copy only
guard-02,Guard,unit,"Prevent 1 damage, then draw.",2,Bo,another note`;
const automatic = prepareCsvImport(source);
ok(automatic.can_import && automatic.rows_importable === 2, "arbitrary designer headers produce a valid two-card preview");
ok(automatic.mapping.map(item => item.target).join(",") === "id,name,type,text,attributes.energy,artist,attributes.unused_note",
  "known aliases map to canonical fields while unfamiliar columns stay as custom data");
ok(automatic.identity_safe, "explicit unique card keys are recognized as rename-safe IDs");
ok(automatic.cards[0].id === "spark_01" && automatic.cards[0].attributes.energy === 1,
  "the preview shows the exact normalized ID and inferred custom attribute");
ok(!publicCsvPreview(automatic).normalized_csv, "the public preview does not duplicate the full transformed source payload");

const remapped = prepareCsvImport(source, ["id", "name", "type", "text", "attributes.cost", "artist", "ignore"]);
ok(remapped.can_import && remapped.cards[1].attributes.cost === 2, "a reviewed custom mapping changes the committed field meaning");
ok(remapped.warnings.some(message => message.includes("Unused note") && message.includes("ignored")),
  "ignored source columns are explicit before commit");

const noName = prepareCsvImport("Code,Power\na,1", ["id", "attributes.power"]);
ok(!noName.can_import && noName.errors.some(message => message.includes("Card name")), "missing card-name mapping fails closed");
const duplicate = prepareCsvImport("Name,Title\nA,B", ["name", "name"]);
ok(!duplicate.can_import && duplicate.errors.some(message => message.includes("assigned to both")), "duplicate targets fail closed");
assert.throws(() => prepareCsvImport("Name\nA", ["attributes.__proto__"]), /unsupported CSV mapping target/);
checks++; console.log("  ✓ unsafe custom attribute targets are rejected");
assert.throws(() => prepareCsvImport("Name,Type\nA,card", ["name"]), /exactly 2 column targets/);
checks++; console.log("  ✓ stale mappings cannot be applied to a different header shape");

const generated = prepareCsvImport("Card Title,Rules\nRenamable,Hello");
ok(generated.can_import && !generated.identity_safe && generated.warnings.some(message => message.includes("permanent 'id'")),
  "name-derived IDs surface the rename-safety warning");

console.log(`\nCSV MAPPING GREEN — ${checks} checks; preview, aliases, custom fields, stable identity, and fail-closed mappings verified.`);
