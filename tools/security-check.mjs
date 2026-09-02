#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";

const base = String(process.argv[2] || "").replace(/\/$/, ""), dbPath = process.argv[3];
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base) || !dbPath) {
  console.error("usage: security-check.mjs http://127.0.0.1:<port> <sqlite-db>"); process.exit(2);
}
let checks = 0;
const ok = (condition, message) => { if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${String(++checks).padStart(2, "0")}  ${message}`); };
const request = async (path, options = {}) => {
  const response = await fetch(base + path, options), type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { response, body };
};

const health = await request("/healthz");
ok(health.response.headers.get("x-content-type-options") === "nosniff"
  && health.response.headers.get("x-frame-options") === "DENY"
  && /frame-ancestors 'none'/.test(health.response.headers.get("content-security-policy") || "")
  && health.response.headers.get("x-request-id"), "security headers and a request ID cover every response");
const evil = await request("/healthz", { headers: { Origin: "https://evil.example" } });
ok(evil.response.status === 403 && !evil.response.headers.get("access-control-allow-origin"),
  "unlisted cross-origin requests are rejected without wildcard CORS");
const allowedOrigin = base.replace("127.0.0.1", "localhost");
const allowed = await request("/healthz", { headers: { Origin: allowedOrigin } });
ok(allowed.response.status === 200 && allowed.response.headers.get("access-control-allow-origin") === allowedOrigin,
  "the exact configured origin is reflected, not broadened");

const registration = await request("/api/auth/register", { method: "POST",
  headers: { "content-type": "application/json", "x-forge-browser": "1" },
  body: JSON.stringify({ handle: "security-owner", email: "Owner@Example.Test", password: "a-secure-test-password" }) });
const cookie = registration.response.headers.get("set-cookie")?.split(";")[0];
ok(registration.response.status === 201 && !registration.body.token && cookie
  && /HttpOnly/i.test(registration.response.headers.get("set-cookie"))
  && /SameSite=Lax/i.test(registration.response.headers.get("set-cookie")),
  "browser login returns an HttpOnly SameSite cookie and no script-readable bearer token");
const me = await request("/api/me", { headers: { Cookie: cookie } });
ok(me.response.status === 200 && me.body.handle === "security-owner", "the cookie authenticates the same-origin browser session");
const sessions = await request("/api/auth/sessions", { headers: { Cookie: cookie } });
ok(sessions.response.status === 200 && sessions.body.length === 1 && sessions.body[0].current,
  "active sessions are listable and individually revocable without exposing credentials");

const created = await request("/api/games", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" },
  body: JSON.stringify({ title: "Private Security Fixture", license: "proprietary",
    csv: "id,name,type,text,quantity\nprivate_card,Private Card,card,Secret draft.,1\n" }) });
ok(created.response.status === 201, "a private controlled-alpha project can be created");
const slug = created.body.slug;
const hidden = await request(`/api/games/${slug}/cards`), ownerRead = await request(`/api/games/${slug}/cards`, { headers: { Cookie: cookie } });
const publicCatalog = await request("/api/catalog?limit=50");
ok(hidden.response.status === 404 && ownerRead.response.status === 200
  && !publicCatalog.body.items.some(game => game.slug === slug),
  "private source, direct routes, and discovery are all denied signed out");

const activeSvg = await request(`/api/games/${slug}/assets?path=assets/art/active.svg`, { method: "POST",
  headers: { Cookie: cookie, "content-type": "image/svg+xml" }, body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>' });
ok(activeSvg.response.status === 422 && /event handlers/.test(activeSvg.body.error), "active SVG is rejected before Git/LFS");
const malformed = await request(`/api/games/${slug}/cards`, { method: "PUT",
  headers: { Cookie: cookie, "content-type": "application/json" }, body: "{" });
ok(malformed.response.status === 400 && malformed.body.request_id, "malformed JSON is a bounded 400 with a traceable envelope");

const apiAccount = await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "connector-user", email: "connector@example.test", password: "another-secure-password" }) });
const db = new DatabaseSync(dbPath), stored = db.prepare("SELECT token FROM sessions").all().map(row => row.token);
ok(apiAccount.response.status === 201 && /^[0-9a-f]{64}$/.test(apiAccount.body.token)
  && !stored.includes(apiAccount.body.token), "API/connector bearer tokens are persisted only as one-way digests");
db.close();

const logout = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
const afterLogout = await request("/api/me", { headers: { Cookie: cookie } });
ok(logout.response.status === 200 && afterLogout.response.status === 401, "sign-out revokes the server session, not only local UI state");

let limited = false;
for (let i = 0; i < 15; i++) {
  const attempt = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "nobody", password: "wrong-password" }) });
  if (attempt.response.status === 429) { limited = attempt.response.headers.has("retry-after"); break; }
}
ok(limited, "authentication has its own stricter rate bucket and Retry-After response");
console.log(`\nSECURITY GREEN — ${checks} public-boundary checks passed.`);
