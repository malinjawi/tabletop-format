#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = JSON.parse(readFileSync(join(root, "schemas/adapter.schema.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, "integrations/adapters/catalog.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
if (!validate(catalog)) throw new Error(validate.errors.map(error => `${error.instancePath} ${error.message}`).join("\n"));
const ids = new Set();
for (const adapter of catalog) {
  if (ids.has(adapter.id)) throw new Error(`duplicate adapter id '${adapter.id}'`); ids.add(adapter.id);
  if (adapter.stage === "publisher" && adapter.status === "stable" && !adapter.credentials.required)
    throw new Error(`publisher '${adapter.id}' must declare authorization`);
  if (adapter.capabilities.includes("round-trip") && adapter.fidelity.level === "artifact-only")
    throw new Error(`adapter '${adapter.id}' cannot claim artifact-only round trip`);
}
console.log(`ADAPTERS GREEN — ${catalog.length} versioned contracts; ${catalog.filter(a => a.status === "stable").length} stable, ${catalog.filter(a => a.status !== "stable").length} explicitly limited.`);
