#!/usr/bin/env node
// Read-only post-deploy verification for an already-running Forge instance.
// It deliberately creates no users, repositories, commits, or releases.

const args = process.argv.slice(2);
const production = args.includes("--production");
const positional = args.filter(arg => !arg.startsWith("--"));
const origin = String(positional[0] || process.env.FORGE_SMOKE_URL || "http://127.0.0.1:4897").replace(/\/$/, "");
const expected = String(process.env.FORGE_SMOKE_EXPECT_PROJECTS || "")
  .split(",").map(value => value.trim()).filter(Boolean);
const rows = [];
const record = (ok, name, detail) => rows.push({ ok, name, detail });

async function get(path) {
  try {
    const response = await fetch(`${origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json, text/plain, text/html" },
    });
    return { response, text: await response.text() };
  } catch (error) {
    return { response: null, text: "", error };
  }
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

const health = await get("/healthz");
const healthBody = parseJson(health.text);
record(health.response?.status === 200 && healthBody?.ok === true,
  "health", health.error?.message || `${health.response?.status || "offline"} ${healthBody?.name || ""}`.trim());

const root = await get("/");
record(root.response?.status === 200 && /Forge/.test(root.text), "application shell",
  `${root.response?.status || "offline"}; ${Buffer.byteLength(root.text)} bytes`);
record(Buffer.byteLength(root.text) < 2_000_000, "application shell budget",
  `${Buffer.byteLength(root.text)} / 2000000 bytes`);

const headers = health.response?.headers;
record(headers?.get("x-content-type-options") === "nosniff", "security headers", "X-Content-Type-Options: nosniff");
record(/frame-ancestors 'none'/.test(headers?.get("content-security-policy") || ""),
  "frame isolation", "CSP frame-ancestors 'none'");
if (production) {
  record(new URL(origin).protocol === "https:", "HTTPS origin", origin);
  record(/max-age=/.test(headers?.get("strict-transport-security") || ""), "HSTS", headers?.get("strict-transport-security") || "missing");
}

const catalogResult = await get("/api/catalog");
const catalog = parseJson(catalogResult.text);
const items = Array.isArray(catalog) ? catalog : catalog?.items;
record(catalogResult.response?.status === 200 && Array.isArray(items), "catalog API",
  `${catalogResult.response?.status || "offline"}; ${Array.isArray(items) ? items.length : 0} project(s)`);
if (Array.isArray(items)) {
  record(items.every(item => !Array.isArray(item.cards) || item.cards.length === 0),
    "lazy catalog", "catalog summaries contain no card faces");
  const identities = new Set(items.flatMap(item => [item.slug, item.project_path, `${item.namespace}/${item.repo_slug}`]));
  for (const project of expected) record(identities.has(project), `expected project ${project}`,
    identities.has(project) ? "present" : "missing");
}

const missing = await get(`/api/games/smoke-private-${Date.now()}`);
record(missing.response?.status === 404, "project non-disclosure", `${missing.response?.status || "offline"} for unknown project`);

for (const policy of ["terms", "privacy", "community", "rights", "support"]) {
  const result = await get(`/policies/${policy}`);
  const placeholders = /\{\{(?:OPERATOR|CONTACT)\}\}/.test(result.text);
  const invalidContact = /support@example\.invalid/.test(result.text);
  record(result.response?.status === 200 && !placeholders && (!production || !invalidContact),
    `${policy} policy`, `${result.response?.status || "offline"}; runtime values ${placeholders || (production && invalidContact) ? "invalid" : "resolved"}`);
}

for (const row of rows) console.log(`${row.ok ? "✓" : "✗"} ${row.name}: ${row.detail}`);
const failures = rows.filter(row => !row.ok);
if (failures.length) {
  console.error(`\nALPHA READINESS FAILED — ${failures.length} check(s) need attention.`);
  process.exit(1);
}
console.log(`\nALPHA READINESS GREEN — ${rows.length} read-only checks passed against ${origin}.`);
